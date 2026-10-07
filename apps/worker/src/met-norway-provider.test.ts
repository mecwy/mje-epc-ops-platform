import { describe, expect, it } from 'vitest';
import type { WeatherQueryDto } from '@mje/contracts';
import {
  MetNorwayError,
  parseMetNorwayForecast,
} from './met-norway-provider.js';
// Entire fixture is synthetic TEST data; no live GPS/provider call.
const now = '2026-10-06T10:00:00Z';
function query(): WeatherQueryDto {
  return {
    projectId: '11111111-1111-4111-8111-111111111111',
    locationVersionId: '22222222-2222-4222-8222-222222222222',
    businessDate: '2026-10-06',
    timezone: 'Europe/Belgrade',
    point: { lat: '45.123456789012', lon: '-19.987699999999' },
    interval: {
      startAt: '2026-10-05T22:00:00Z',
      endAt: '2026-10-06T22:00:00Z',
    },
    product: 'forecast',
    model: 'forecast',
  };
}
function fixture() {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-19.9876, 45.1234, 2] },
    properties: {
      meta: {
        updated_at: '2026-10-06T09:00:00Z',
        units: {
          air_temperature: 'celsius',
          wind_speed: 'm/s',
          precipitation_amount: 'mm',
        },
      },
      timeseries: [0, 1].map((h) => ({
        time: `2026-10-06T${10 + h}:00:00Z`,
        data: {
          instant: {
            details: {
              air_temperature: 0,
              wind_speed: 2,
              wind_speed_of_gust: null,
            },
          },
          next_1_hours: {
            summary: { symbol_code: 'clearsky_day' },
            details: { precipitation_amount: 0 },
          },
          next_6_hours: {
            summary: { symbol_code: 'rain' },
            details: { precipitation_amount: 3 },
          },
          next_12_hours: { summary: { symbol_code: 'cloudy' }, details: {} },
        },
      })),
    },
  };
}
describe('MET real product semantics', () => {
  it('retains UTC instants, overlapping periods, strings, units, zero and original site text', () => {
    const input = fixture(),
      before = structuredClone(input),
      q = query();
    const d = parseMetNorwayForecast(input, q, now);
    expect(d.provider).toBe('met-norway');
    if (d.provider !== 'met-norway') throw new Error('TEST');
    expect(d.query.point).toEqual(q.point);
    expect(d.forecast.outboundPoint).toEqual({
      lat: '45.1234',
      lon: '-19.9876',
    });
    expect(d.grid).toBeNull();
    expect(d.publishedAt).toBeNull();
    expect(d.coverage).toBe('partial');
    expect(d.forecast.providerUpdatedAt).toBe('2026-10-06T09:00:00Z');
    expect(d.forecast.instants[0]?.airTemperature).toEqual({
      state: 'value',
      value: '0',
      raw: '0',
      unit: 'celsius',
    });
    expect(d.forecast.instants[0]?.gust).toEqual({
      state: 'missing',
      raw: null,
      unit: null,
      reason: 'provider_null',
    });
    expect(d.forecast.periods.map((p) => p.hours)).toEqual([
      1, 6, 12, 1, 6, 12,
    ]);
    expect(d.forecast.periods[0]?.symbolCode).toBe('clearsky_day');
    expect(d.forecast.periods[0]?.precipitation.state).toBe('value');
    expect(d.forecast.periods[2]?.precipitation.state).toBe('missing');
    expect(
      Object.values(d.metrics).every((m) => m.state === 'not_applicable'),
    ).toBe(true);
    expect(input).toEqual(before);
  });
  it('keeps absent unit unknown instead of claiming a physical value', () => {
    const b = fixture();
    delete (b.properties.meta.units as Record<string, unknown>)['wind_speed'];
    const d = parseMetNorwayForecast(b, query(), now);
    if (d.provider !== 'met-norway') throw new Error('TEST');
    expect(d.forecast.instants[0]?.windSpeed).toEqual({
      state: 'unknown',
      raw: '2',
      unit: null,
      reason: 'unit_missing',
    });
  });
  it('never falls back to current forecast for a past day or outside the provider window', () => {
    const past = {
      ...query(),
      businessDate: '2026-10-05',
      interval: {
        startAt: '2026-10-04T22:00:00Z',
        endAt: '2026-10-05T22:00:00Z',
      },
      product: 'historical-weather' as const,
      model: 'era5' as const,
    };
    for (const q of [
      past,
      {
        ...query(),
        businessDate: '2026-10-20',
        interval: {
          startAt: '2026-10-19T22:00:00Z',
          endAt: '2026-10-20T22:00:00Z',
        },
      },
    ]) {
      expect(() => parseMetNorwayForecast(fixture(), q, now)).toThrowError(
        new MetNorwayError('NO_HISTORY'),
      );
    }
  });
  it.each([
    'duplicate',
    'out-of-order',
    'bad-symbol',
    'bad-number',
    'bad-date',
    'bad-geometry',
    'oversize',
  ])('rejects %s safely', (variant) => {
    const b = fixture();
    const rows = b.properties.timeseries;
    if (variant === 'duplicate') rows[1]!.time = rows[0]!.time;
    if (variant === 'out-of-order') rows.reverse();
    if (variant === 'bad-symbol')
      rows[0]!.data.next_1_hours.summary.symbol_code = 'TEST secret <script>';
    if (variant === 'bad-number')
      rows[0]!.data.instant.details.wind_speed = Infinity;
    if (variant === 'bad-date') rows[0]!.time = '2026-02-30T10:00:00Z';
    if (variant === 'bad-geometry') b.geometry.coordinates[0] = 181;
    if (variant === 'oversize')
      b.properties.timeseries = Array(501).fill(rows[0]);
    expect(() => parseMetNorwayForecast(b, query(), now)).toThrowError(
      new MetNorwayError('INVALID_RESPONSE'),
    );
  });
  it.each([
    ['2026-03-29', '2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z', 23],
    ['2026-10-25', '2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z', 25],
  ])(
    'preserves DST business interval %s without assuming 24 hours',
    (day, startAt, endAt, hours) => {
      const b = fixture();
      b.properties.timeseries[0]!.time = new Date(
        Date.parse(startAt) + 3600000,
      ).toISOString();
      b.properties.timeseries[1]!.time = new Date(
        Date.parse(startAt) + 7200000,
      ).toISOString();
      const q = { ...query(), businessDate: day, interval: { startAt, endAt } };
      const d = parseMetNorwayForecast(
        b,
        q,
        new Date(Date.parse(startAt) + 1000).toISOString(),
      );
      expect(
        (Date.parse(d.query.interval.endAt) -
          Date.parse(d.query.interval.startAt)) /
          3600000,
      ).toBe(hours);
    },
  );
});
