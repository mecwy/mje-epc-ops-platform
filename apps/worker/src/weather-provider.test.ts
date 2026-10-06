import { describe, expect, it, vi } from 'vitest';
import {
  fetchOpenMeteo,
  parseOpenMeteoDaily,
  type OpenMeteoQuery,
} from './weather-provider.js';

// Synthetic TEST provider responses; no default or real HTTP transport exists.
const query = (): OpenMeteoQuery => ({
  projectId: 'TEST-project',
  locationVersionId: 'TEST-location-v1',
  businessDate: '2026-10-05',
  timezone: 'Europe/Belgrade',
  point: { lat: '45.000000', lon: '19.000000' },
  interval: { startAt: '2026-10-04T22:00:00Z', endAt: '2026-10-05T22:00:00Z' },
  product: 'historical-weather',
  model: 'era5',
});
const now = '2026-10-06T10:00:00Z';
const body = () => ({
  latitude: 45.01,
  longitude: 19.01,
  timezone: 'Europe/Belgrade',
  generationtime_ms: 0.1,
  daily: {
    time: ['2026-10-05'],
    weather_code: [0],
    temperature_2m_min: [0],
    temperature_2m_max: [12],
    precipitation_sum: [0],
    wind_speed_10m_max: [1],
    wind_gusts_10m_max: [2],
  },
  daily_units: {
    weather_code: 'wmo code',
    temperature_2m_min: '°C',
    temperature_2m_max: '°C',
    precipitation_sum: 'mm',
    wind_speed_10m_max: 'm/s',
    wind_gusts_10m_max: 'm/s',
  },
});
type Draft = {
  category: string;
  coverage: string;
  fetchedAt: string;
  publishedAt: null;
  metrics: Record<
    string,
    { state: string; value?: string; unit: string | null; reason?: string }
  >;
  grid: unknown;
};
const parse = (input: unknown) => input as Draft;

describe('Open-Meteo replaceable parsing candidate', () => {
  it('preserves zero, units, separate grid and unknown publication time', () => {
    const input = body();
    const original = structuredClone(input);
    const r = parse(parseOpenMeteoDaily(input, query(), now));
    expect(r.metrics['precipitation']).toMatchObject({
      state: 'value',
      value: '0',
      unit: 'mm',
    });
    expect(r.grid).toEqual({ lat: '45.01', lon: '19.01' });
    expect(r.publishedAt).toBeNull();
    expect(r.fetchedAt).toBe(now);
    expect(input).toEqual(original);
  });
  it('keeps provider null distinct from an omitted variable', () => {
    const input: Record<string, unknown> = body();
    const daily = input['daily'] as Record<string, unknown>;
    daily['precipitation_sum'] = [null];
    delete daily['wind_gusts_10m_max'];
    const r = parse(parseOpenMeteoDaily(input, query(), now));
    expect(r.coverage).toBe('partial');
    expect(r.metrics['precipitation']).toMatchObject({
      state: 'missing',
      reason: 'provider_null',
    });
    expect(r.metrics['gustMax']).toMatchObject({
      state: 'missing',
      reason: 'not_provided',
    });
  });
  it('retains a different original unit instead of silently converting', () => {
    const input = body();
    input.daily_units.precipitation_sum = 'inch';
    expect(
      parse(parseOpenMeteoDaily(input, query(), now)).metrics['precipitation']
        ?.unit,
    ).toBe('inch');
  });
  it('a numeric result without its unit remains unknown', () => {
    const input: Record<string, unknown> = body();
    input['daily_units'] = {};
    const r = parse(parseOpenMeteoDaily(input, query(), now));
    expect(r.coverage).toBe('partial');
    expect(r.metrics['precipitation']).toMatchObject({
      state: 'unknown',
      reason: 'unit_missing',
    });
    expect(r.metrics['precipitation']).not.toHaveProperty('value');
  });
  it.each([
    { current: { temperature_2m: 30 } },
    { ...body(), daily: { ...body().daily, time: ['2026-10-06'] } },
    { ...body(), timezone: 'UTC' },
    { ...body(), daily: { ...body().daily, precipitation_sum: ['0'] } },
    { ...body(), daily: { ...body().daily, precipitation_sum: [Infinity] } },
    { ...body(), daily: { ...body().daily, precipitation_sum: [0, 1] } },
    { ...body(), latitude: 91 },
  ])(
    'rejects mismatched/malformed responses, never falls back to current',
    (input) => {
      expect(() => parseOpenMeteoDaily(input, query(), now)).toThrow(
        'WEATHER_INVALID_RESPONSE',
      );
    },
  );
  it.each([
    ['era5', 'reanalysis'],
    ['ifs', 'analysis'],
    ['forecast', 'forecast'],
  ] as const)('labels %s honestly', (model, category) => {
    expect(
      parse(parseOpenMeteoDaily(body(), { ...query(), model }, now)).category,
    ).toBe(category);
  });
  it('validates before transport and supplies the exact requested day/product', async () => {
    const transport = vi.fn(async (q: OpenMeteoQuery) => {
      expect(q).toEqual(query());
      return { status: 200, body: body() };
    });
    const acceptQuery = vi.fn(() => query());
    const r = await fetchOpenMeteo(
      {},
      { transport, acceptQuery, acceptReference: parse, now: () => now },
      new AbortController().signal,
    );
    expect(r.category).toBe('reanalysis');
    expect(acceptQuery).toHaveBeenCalledBefore(transport);
  });
  it('rejected queries cannot reach a transport', async () => {
    const transport = vi.fn();
    await expect(
      fetchOpenMeteo(
        {},
        {
          transport,
          acceptQuery: () => {
            throw new Error('INVALID_INPUT');
          },
          acceptReference: parse,
          now: () => now,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('INVALID_INPUT');
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    [429, 'WEATHER_RATE_LIMITED'],
    [503, 'WEATHER_UNAVAILABLE'],
    [401, 'WEATHER_UNAVAILABLE'],
  ] as const)('uses safe error for HTTP %s', async (status, code) => {
    await expect(
      fetchOpenMeteo(
        {},
        {
          transport: async () => ({ status, body: { secret: 'TEST-secret' } }),
          acceptQuery: () => query(),
          acceptReference: parse,
          now: () => now,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(code);
  });
  it('does not echo transport exceptions or decoder input', async () => {
    const d = {
      acceptQuery: () => query(),
      acceptReference: parse,
      now: () => now,
      transport: async () => {
        throw new Error('TEST-coordinate-and-key');
      },
    };
    await expect(
      fetchOpenMeteo({}, d, new AbortController().signal),
    ).rejects.toThrow(/^WEATHER_UNAVAILABLE$/);
    await expect(
      fetchOpenMeteo(
        {},
        {
          ...d,
          transport: async () => ({ status: 200, body: body() }),
          acceptReference: () => {
            throw new Error('TEST-coordinate');
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/^WEATHER_INVALID_RESPONSE$/);
  });
  it('cancellation drops a late provider result', async () => {
    const controller = new AbortController();
    const decode = vi.fn(parse);
    await expect(
      fetchOpenMeteo(
        {},
        {
          acceptQuery: () => query(),
          acceptReference: decode,
          now: () => now,
          transport: async () => {
            controller.abort();
            return { status: 200, body: body() };
          },
        },
        controller.signal,
      ),
    ).rejects.toThrow('WEATHER_CANCELLED');
    expect(decode).not.toHaveBeenCalled();
  });
});
