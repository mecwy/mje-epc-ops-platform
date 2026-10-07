import { describe, expect, it, vi } from 'vitest';
import type { WeatherQueryDto } from '@mje/contracts';
import {
  createMetNorwayTransport,
  type MetCacheEntry,
  type MetSharedGate,
} from './met-norway-transport.js';
import { MetNorwayError } from './met-norway-provider.js';
const initial = '2026-10-06T10:00:00Z',
  agent = 'MJE-TEST/1.0 https://example.invalid/weather-contact';
function query(): WeatherQueryDto {
  return {
    projectId: '11111111-1111-4111-8111-111111111111',
    locationVersionId: '22222222-2222-4222-8222-222222222222',
    businessDate: '2026-10-06',
    timezone: 'UTC',
    point: { lat: '45.123499999999', lon: '19.987699999999' },
    interval: {
      startAt: '2026-10-06T00:00:00Z',
      endAt: '2026-10-07T00:00:00Z',
    },
    product: 'forecast',
    model: 'forecast',
  };
}
function fixture() {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [19.9876, 45.1234] },
    properties: {
      meta: {
        updated_at: '2026-10-06T09:00:00Z',
        units: {
          air_temperature: 'celsius',
          wind_speed: 'm/s',
          precipitation_amount: 'mm',
        },
      },
      timeseries: ['2026-10-06T10:00:00Z', '2026-10-07T10:00:00Z'].map(
        (time) => ({
          time,
          data: {
            instant: { details: { air_temperature: 0, wind_speed: 2 } },
            next_1_hours: {
              summary: { symbol_code: 'rain' },
              details: { precipitation_amount: 0 },
            },
          },
        }),
      ),
    },
  };
}
function response(
  status = 200,
  headers: Record<string, string> = {},
  value: unknown = fixture(),
) {
  return new Response(status === 304 ? null : JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json',
      expires: 'Tue, 06 Oct 2026 11:00:00 GMT',
      'last-modified': 'Tue, 06 Oct 2026 09:00:00 GMT',
      ...headers,
    },
  });
}
// TEST fake port only: shared state models the protocol, not proof of real PG/RLS/durability.
function setup() {
  let now = initial,
    token = 0,
    cooldown = 0;
  const entries = new Map<string, MetCacheEntry>(),
    leases = new Map<string, string>();
  const gate: MetSharedGate = {
    take: vi.fn(async (key, at) => {
      if (cooldown > Date.parse(at))
        return {
          state: 'busy' as const,
          retryAfterSeconds: (cooldown - Date.parse(at)) / 1000,
        };
      const entry = entries.get(key);
      if (entry && Date.parse(entry.expiresAt) > Date.parse(at))
        return { state: 'fresh' as const, entry };
      if (leases.has(key))
        return { state: 'busy' as const, retryAfterSeconds: 5 };
      const lease = { key, token: String(++token) };
      leases.set(key, lease.token);
      return { state: 'leased' as const, lease, entry: entry ?? null };
    }),
    commit: vi.fn(async (l, e) => {
      if (leases.get(l.key) !== l.token) return false;
      entries.set(l.key, e);
      return true;
    }),
    release: vi.fn(async (l) => {
      if (leases.get(l.key) === l.token) leases.delete(l.key);
    }),
    throttle: vi.fn(async (_, until) => {
      cooldown = Math.max(cooldown, Date.parse(until));
    }),
  };
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    void url;
    void init;
    return response();
  });
  const deps = { userAgent: agent, fetch, now: () => now, gate };
  return {
    deps,
    gate,
    fetch,
    entries,
    leases,
    setNow: (at: string) => {
      now = at;
    },
  };
}
const signal = () => new AbortController().signal;
describe('MET injected HTTP and shared gate protocol', () => {
  it('requires a configured identity/contact and gate; never supplies a default spoofed UA', () => {
    const s = setup();
    for (const userAgent of [
      '',
      'anonymous',
      'MJE\r\nTEST https://example.invalid',
    ])
      expect(() => createMetNorwayTransport({ ...s.deps, userAgent })).toThrow(
        'MET_CONFIGURATION_REQUIRED',
      );
    expect(() =>
      createMetNorwayTransport({ ...s.deps, gate: undefined as never }),
    ).toThrow('MET_CONFIGURATION_REQUIRED');
  });
  it('truncates the site request, sends contact/HTTPS/gzip and preserves Last-Modified exactly', async () => {
    const s = setup(),
      request = createMetNorwayTransport(s.deps),
      q = query();
    const draft = await request(q, signal());
    expect(s.fetch.mock.calls[0]?.[0]).toBe(
      'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=45.1234&lon=19.9876',
    );
    expect(s.fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'User-Agent': agent, 'Accept-Encoding': 'gzip' },
      redirect: 'manual',
    });
    expect(draft.query.point).toEqual(q.point);
    expect([...s.entries.values()][0]?.lastModified).toBe(
      'Tue, 06 Oct 2026 09:00:00 GMT',
    );
    expect(s.leases.size).toBe(0);
  });
  it('different days/replacement transport share a fresh full document with no second HTTP and retain real fetchedAt', async () => {
    const s = setup();
    await createMetNorwayTransport(s.deps)(query(), signal());
    s.setNow('2026-10-06T10:30:00Z');
    const next = {
      ...query(),
      businessDate: '2026-10-07',
      interval: {
        startAt: '2026-10-07T00:00:00Z',
        endAt: '2026-10-08T00:00:00Z',
      },
    };
    const d = await createMetNorwayTransport(s.deps)(next, signal());
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(d.fetchedAt).toBe(initial);
    expect(d.query.businessDate).toBe('2026-10-07');
  });
  it('expired entry makes conditional request;304 retains body/update while refreshing expiry/fetch time', async () => {
    const s = setup();
    const request = createMetNorwayTransport(s.deps);
    await request(query(), signal());
    s.setNow('2026-10-06T11:01:00Z');
    s.fetch.mockImplementation(async () =>
      response(304, { expires: 'Tue, 06 Oct 2026 12:00:00 GMT' }),
    );
    const d = await request(query(), signal());
    expect(s.fetch.mock.calls[1]?.[1].headers).toMatchObject({
      'If-Modified-Since': 'Tue, 06 Oct 2026 09:00:00 GMT',
    });
    expect(d.fetchedAt).toBe('2026-10-06T11:01:00Z');
    if (d.provider !== 'met-norway') throw new Error('TEST');
    expect(d.forecast.providerUpdatedAt).toBe('2026-10-06T09:00:00Z');
    expect(d.forecast.instants[0]?.airTemperature.state).toBe('value');
  });
  it('two consumers/different request identities on one point allow only one in-flight HTTP', async () => {
    const s = setup();
    let resolve!: (r: Response) => void;
    s.fetch.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const first = createMetNorwayTransport(s.deps)(query(), signal());
    await Promise.resolve();
    await Promise.resolve();
    await expect(
      createMetNorwayTransport(s.deps)(
        { ...query(), projectId: '33333333-3333-4333-8333-333333333333' },
        signal(),
      ),
    ).rejects.toThrow('MET_RATE_LIMITED');
    expect(s.fetch).toHaveBeenCalledTimes(1);
    resolve(response());
    await first;
  });
  it.each([
    ['120', 120],
    ['Tue, 06 Oct 2026 10:02:00 GMT', 120],
    [null, 60],
    ['99999999', 86400],
    ['broken', 60],
  ])(
    '429 %s imposes provider-wide cooldown on other points',
    async (header, delay) => {
      const s = setup();
      s.fetch.mockImplementation(async () =>
        response(429, header === null ? {} : { 'retry-after': header }),
      );
      const request = createMetNorwayTransport(s.deps);
      await expect(request(query(), signal())).rejects.toMatchObject({
        code: 'RATE_LIMITED',
        retryAfterSeconds: delay,
      });
      await expect(
        request({ ...query(), point: { lat: '46', lon: '20' } }, signal()),
      ).rejects.toMatchObject({
        code: 'RATE_LIMITED',
        retryAfterSeconds: delay,
      });
      expect(s.fetch).toHaveBeenCalledTimes(1);
      expect(s.gate.throttle).toHaveBeenCalledTimes(1);
      expect(s.leases.size).toBe(0);
    },
  );
  it.each([
    '304-empty',
    'missing-expires',
    'expired',
    'wrong-content',
    'oversize',
    'bad-json',
    'bad-product',
    'off-origin',
    'wrong-coordinate-redirect',
  ])('refuses %s and releases the cache lease', async (variant) => {
    const s = setup();
    s.fetch.mockImplementation(async () => {
      if (variant === '304-empty') return response(304);
      if (variant === 'missing-expires') {
        const r = response();
        r.headers.delete('expires');
        return r;
      }
      if (variant === 'expired')
        return response(200, { expires: 'Tue, 06 Oct 2026 09:00:00 GMT' });
      if (variant === 'wrong-content')
        return response(200, { 'content-type': 'text/html' });
      if (variant === 'oversize')
        return response(200, {}, 'x'.repeat(2 * 1024 * 1024));
      if (variant === 'bad-json')
        return new Response('{', {
          headers: {
            'content-type': 'application/json',
            expires: 'Tue, 06 Oct 2026 11:00:00 GMT',
          },
        });
      if (variant === 'bad-product') return response(200, {}, {});
      return response(302, {
        location:
          variant === 'off-origin'
            ? 'https://example.invalid/secret'
            : '?lat=46&lon=20',
      });
    });
    await expect(
      createMetNorwayTransport(s.deps)(query(), signal()),
    ).rejects.toBeInstanceOf(MetNorwayError);
    expect(s.gate.commit).not.toHaveBeenCalled();
    expect(s.leases.size).toBe(0);
  });
  it('supports one same-endpoint redirect, but bounds endless redirects', async () => {
    const s = setup();
    s.fetch.mockResolvedValueOnce(
      response(307, {
        location:
          'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=45.1234&lon=19.9876',
      }),
    );
    await createMetNorwayTransport(s.deps)(query(), signal());
    expect(s.fetch).toHaveBeenCalledTimes(2);
    const x = setup();
    x.fetch.mockImplementation(async () =>
      response(307, { location: '?lat=45.1234&lon=19.9876' }),
    );
    await expect(
      createMetNorwayTransport(x.deps)(query(), signal()),
    ).rejects.toThrow('MET_UNAVAILABLE');
    expect(x.fetch).toHaveBeenCalledTimes(3);
  });
  it('stale token cannot cache-publish or return a ready draft', async () => {
    const s = setup();
    s.gate.commit = vi.fn(async () => false);
    await expect(
      createMetNorwayTransport(s.deps)(query(), signal()),
    ).rejects.toThrow('MET_UNAVAILABLE');
    expect(s.entries.size).toBe(0);
    expect(s.leases.size).toBe(0);
  });
  it('rejects cancellation even during gate acquisition and still returns its lease', async () => {
    const s = setup(),
      c = new AbortController();
    const original = s.gate.take;
    s.gate.take = async (...args) => {
      const result = await original(...args);
      c.abort();
      return result;
    };
    await expect(
      createMetNorwayTransport(s.deps)(query(), c.signal),
    ).rejects.toThrow('MET_CANCELLED');
    expect(s.fetch).not.toHaveBeenCalled();
    expect(s.leases.size).toBe(0);
  });
  it('does not contact gate or HTTP for historical requests or an already aborted request', async () => {
    const s = setup(),
      r = createMetNorwayTransport(s.deps);
    const c = new AbortController();
    c.abort();
    await expect(r(query(), c.signal)).rejects.toThrow('MET_CANCELLED');
    const q = {
      ...query(),
      businessDate: '2026-10-05',
      interval: {
        startAt: '2026-10-05T00:00:00Z',
        endAt: '2026-10-06T00:00:00Z',
      },
      product: 'historical-weather' as const,
      model: 'era5' as const,
    };
    await expect(r(q, signal())).rejects.toThrow('MET_NO_HISTORY');
    expect(s.gate.take).not.toHaveBeenCalled();
    expect(s.fetch).not.toHaveBeenCalled();
  });
  it('network exceptions reveal only a safe code and release ownership', async () => {
    const s = setup();
    s.fetch.mockRejectedValue(new Error('TEST coordinates credential payload'));
    await expect(
      createMetNorwayTransport(s.deps)(query(), signal()),
    ).rejects.toThrow('MET_UNAVAILABLE');
    expect(s.leases.size).toBe(0);
  });
  it('abort during HTTP settles and releases its gate before the runtime may close the pool', async () => {
    const s = setup(),
      c = new AbortController();
    let sawAbort = false;
    s.fetch.mockImplementation(
      async (_, init) =>
        new Promise<Response>((_, reject) => {
          init.signal!.addEventListener(
            'abort',
            () => {
              sawAbort = true;
              reject(new Error('TEST abort raw details'));
            },
            { once: true },
          );
        }),
    );
    const pending = createMetNorwayTransport(s.deps)(query(), c.signal);
    await Promise.resolve();
    await Promise.resolve();
    c.abort();
    await expect(pending).rejects.toThrow('MET_CANCELLED');
    expect(sawAbort).toBe(true);
    expect(s.gate.commit).not.toHaveBeenCalled();
    expect(s.leases.size).toBe(0);
  });
  it('abort interrupts a stalled body reader and prevents cache publication', async () => {
    const s = setup(),
      c = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    s.fetch.mockResolvedValue(
      new Response(stream, {
        headers: {
          'content-type': 'application/json',
          expires: 'Tue, 06 Oct 2026 11:00:00 GMT',
        },
      }),
    );
    const pending = createMetNorwayTransport(s.deps)(query(), c.signal);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    c.abort();
    await expect(pending).rejects.toThrow('MET_CANCELLED');
    expect(cancelled).toBe(true);
    expect(s.gate.commit).not.toHaveBeenCalled();
    expect(s.leases.size).toBe(0);
  });
});
