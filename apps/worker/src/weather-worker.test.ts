import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runWeatherOnce,
  type WeatherWorkerDependencies,
  type WeatherWorkerLease,
} from './weather-worker.js';
import {
  createMetNorwayTransport,
  type MetSharedGate,
} from './met-norway-transport.js';
import { MetNorwayError } from './met-norway-provider.js';
const lease = { requestId: 'TEST-request', query: {} } as WeatherWorkerLease;
function setup(enabled?: boolean) {
  const d: WeatherWorkerDependencies<unknown, WeatherWorkerLease> = {
    ...(enabled === undefined ? {} : { enabled }),
    jobs: {
      claim: vi.fn(async () => lease),
      finish: vi.fn(async () => true),
      fail: vi.fn(async () => true),
    },
    provider: {
      acceptQuery: (v) => v as never,
      acceptReference: (v) => v,
      transport: vi.fn(async () => ({ status: 503, body: {} })),
      now: () => '2026-10-06T12:00:00Z',
    },
  };
  return d;
}
afterEach(() => vi.useRealTimers());
describe('finite injected worker', () => {
  it('default disabled never contacts transport', async () => {
    const d = setup();
    expect(await runWeatherOnce(d)).toEqual({
      state: 'disabled',
      requestId: null,
    });
    expect(d.provider!.transport).not.toHaveBeenCalled();
    expect(d.jobs.claim).not.toHaveBeenCalled();
    expect(d.jobs.fail).not.toHaveBeenCalled();
  });
  it('empty queue requires no provider or failure call', async () => {
    const d = setup(true);
    d.jobs.claim = async () => null;
    expect(await runWeatherOnce(d)).toEqual({ state: 'idle', requestId: null });
    expect(d.provider!.transport).not.toHaveBeenCalled();
    expect(d.jobs.fail).not.toHaveBeenCalled();
  });
  it('bounds a transport ignoring abort at eight seconds, with no late publish', async () => {
    vi.useFakeTimers();
    const d = setup(true);
    let resolve!: (v: { status: number; body: unknown }) => void;
    let signal!: AbortSignal;
    d.provider!.transport = (_, s) => {
      signal = s;
      return new Promise((r) => {
        resolve = r;
      });
    };
    const pending = runWeatherOnce(d);
    await vi.advanceTimersByTimeAsync(8000);
    expect((await pending).state).toBe('unavailable');
    expect(signal.aborted).toBe(true);
    resolve({ status: 200, body: {} });
    await Promise.resolve();
    expect(d.jobs.finish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not leak transport errors or claim success after stale failure token', async () => {
    const d = setup(true);
    d.provider!.transport = async () => {
      throw new Error('TEST private coordinate/key');
    };
    d.jobs.fail = async () => false;
    expect(await runWeatherOnce(d)).toEqual({
      state: 'stale',
      requestId: 'TEST-request',
    });
    expect(d.jobs.finish).not.toHaveBeenCalled();
  });
  it('maps 429 to a safe rate-limit terminal/retry port code', async () => {
    const d = setup(true);
    d.provider!.transport = async () => ({ status: 429, body: 'TEST private' });
    expect((await runWeatherOnce(d)).state).toBe('unavailable');
    expect(d.jobs.fail).toHaveBeenCalledWith(lease, 'RATE_LIMITED');
  });
});

describe('provider-neutral MET job execution', () => {
  function busyWorker(delay = 120) {
    const d = setup(true);
    const busyLease: WeatherWorkerLease = {
      requestId: 'TEST-busy',
      query: {
        projectId: '11111111-1111-4111-8111-111111111111',
        locationVersionId: '22222222-2222-4222-8222-222222222222',
        businessDate: '2026-10-06',
        timezone: 'UTC',
        point: { lat: '45', lon: '19' },
        interval: {
          startAt: '2026-10-06T00:00:00Z',
          endAt: '2026-10-07T00:00:00Z',
        },
        product: 'forecast',
        model: 'forecast',
      },
    };
    d.jobs.claim = vi.fn(async () => busyLease);
    const gate: MetSharedGate = {
      take: async () => ({ state: 'busy', retryAfterSeconds: delay }),
      commit: async () => false,
      release: async () => {},
      throttle: async () => {},
    };
    const fetch = vi.fn(async (): Promise<Response> => {
      throw new Error('TEST HTTP must not run');
    });
    d.execute = createMetNorwayTransport({
      userAgent: 'TEST https://example.invalid/contact',
      fetch,
      now: () => '2026-10-06T10:00:00Z',
      gate,
    });
    return { d, fetch, busyLease };
  }
  it('gate busy defers without marking a supplier failure or publishing', async () => {
    const { d, fetch, busyLease } = busyWorker();
    d.jobs.defer = vi.fn(async () => true);
    expect(await runWeatherOnce(d)).toEqual({
      state: 'idle',
      requestId: busyLease.requestId,
    });
    expect(d.jobs.defer).toHaveBeenCalledWith(busyLease, 120);
    expect(d.jobs.fail).not.toHaveBeenCalled();
    expect(d.jobs.finish).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('a stale defer token stays stale and missing defer fails closed', async () => {
    const { d } = busyWorker();
    d.jobs.defer = vi.fn(async () => false);
    expect((await runWeatherOnce(d)).state).toBe('stale');
    delete d.jobs.defer;
    await expect(runWeatherOnce(d)).rejects.toThrow('WEATHER_DEFER_REQUIRED');
    expect(d.jobs.fail).not.toHaveBeenCalled();
  });
  it('invalid response reaches the terminal port without a retry delay', async () => {
    const d = setup(true);
    d.execute = async () => {
      throw new MetNorwayError('INVALID_RESPONSE');
    };
    expect((await runWeatherOnce(d)).state).toBe('unavailable');
    expect(d.jobs.fail).toHaveBeenCalledExactlyOnceWith(
      lease,
      'INVALID_RESPONSE',
    );
    expect(d.jobs.finish).not.toHaveBeenCalled();
  });
  it('publishes through the existing stale-token fence without any Open-Meteo call', async () => {
    const d = setup(true),
      draft = { TEST: 'MET' };
    d.execute = async () => draft;
    expect((await runWeatherOnce(d)).state).toBe('ready');
    expect(d.jobs.finish).toHaveBeenCalledWith(lease, draft);
    expect(d.provider!.transport).not.toHaveBeenCalled();
    d.jobs.finish = async () => false;
    expect((await runWeatherOnce(d)).state).toBe('stale');
  });
  it('forwards validated Retry-After to domain retry scheduling', async () => {
    const { MetNorwayError } = await import('./met-norway-provider.js');
    const d = setup(true);
    d.execute = async () => {
      throw new MetNorwayError('RATE_LIMITED', 120);
    };
    await runWeatherOnce(d);
    expect(d.jobs.fail).toHaveBeenCalledWith(lease, 'RATE_LIMITED', 120);
    d.execute = async () => {
      throw new MetNorwayError('NO_HISTORY');
    };
    await runWeatherOnce(d);
    expect(d.jobs.fail).toHaveBeenCalledWith(lease, 'NO_HISTORY');
  });
  it('shutdown joins cooperative provider cleanup and never publishes after cancellation', async () => {
    const d = setup(true),
      c = new AbortController();
    let settled = false;
    d.execute = async (_, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            queueMicrotask(() => {
              settled = true;
              resolve();
            });
          },
          { once: true },
        ),
      );
      return {};
    };
    const pending = runWeatherOnce(d, c.signal);
    await Promise.resolve();
    c.abort();
    await pending;
    expect(settled).toBe(true);
    expect(d.jobs.finish).not.toHaveBeenCalled();
    expect(d.jobs.fail).toHaveBeenCalledWith(lease, 'UNAVAILABLE');
  });
});
