import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runWeatherOnce,
  type WeatherWorkerDependencies,
  type WeatherWorkerLease,
} from './weather-worker.js';
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
      requestId: 'TEST-request',
    });
    expect(d.provider.transport).not.toHaveBeenCalled();
    expect(d.jobs.fail).toHaveBeenCalledWith(lease, 'DISABLED');
  });
  it('empty queue requires no provider or failure call', async () => {
    const d = setup(true);
    d.jobs.claim = async () => null;
    expect(await runWeatherOnce(d)).toEqual({ state: 'idle', requestId: null });
    expect(d.provider.transport).not.toHaveBeenCalled();
    expect(d.jobs.fail).not.toHaveBeenCalled();
  });
  it('bounds a transport ignoring abort at eight seconds, with no late publish', async () => {
    vi.useFakeTimers();
    const d = setup(true);
    let resolve!: (v: { status: number; body: unknown }) => void;
    let signal!: AbortSignal;
    d.provider.transport = (_, s) => {
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
    d.provider.transport = async () => {
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
    d.provider.transport = async () => ({ status: 429, body: 'TEST private' });
    expect((await runWeatherOnce(d)).state).toBe('unavailable');
    expect(d.jobs.fail).toHaveBeenCalledWith(lease, 'RATE_LIMITED');
  });
});
