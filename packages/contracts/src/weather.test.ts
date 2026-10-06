import { describe, expect, it } from 'vitest';
import {
  parseWeatherQuery,
  parseWeatherReferenceDraft,
  parseWeatherValue,
  parseReportLocationCandidate,
  WEATHER_METRICS,
  weatherCategory,
} from './weather.js';

// All locations and dates below are synthetic TEST inputs.
const now = '2026-10-06T10:00:00Z';
const query = () => ({
  projectId: '11111111-1111-4111-8111-111111111111',
  locationVersionId: '22222222-2222-4222-8222-222222222222',
  businessDate: '2026-10-05',
  timezone: 'Europe/Belgrade',
  point: { lat: '45.000000', lon: '19.000000' },
  interval: { startAt: '2026-10-04T22:00:00Z', endAt: '2026-10-05T22:00:00Z' },
  product: 'historical-weather',
  model: 'era5',
});
const value = () => ({ state: 'value', value: '0', raw: '0.000', unit: 'mm' });
const reference = () => ({
  provider: 'open-meteo',
  query: query(),
  category: 'reanalysis',
  fetchedAt: now,
  publishedAt: null,
  coverage: 'complete',
  grid: null,
  metrics: Object.fromEntries(WEATHER_METRICS.map((key) => [key, value()])),
});

describe('weather boundary — CG-I07 / CG-I09', () => {
  it('preserves explicit zero, raw precision and original unit', () => {
    expect(parseWeatherValue(value())).toEqual(value());
    expect(parseWeatherValue({ ...value(), unit: 'inch' }).unit).toBe('inch');
  });
  it.each([
    { state: 'blank', raw: '', unit: null, reason: 'reported_blank' },
    { state: 'missing', raw: null, unit: 'mm', reason: 'not_provided' },
    {
      state: 'unknown',
      raw: 'unknown',
      unit: 'mm',
      reason: 'reported_unknown',
    },
    { state: 'not_applicable', raw: 'na', unit: null, reason: 'reported_na' },
  ])('does not convert $state into zero', (input) => {
    expect(parseWeatherValue(input)).toEqual(input);
    expect(parseWeatherValue(input)).not.toHaveProperty('value');
  });
  it.each([
    { ...value(), value: 0 },
    { ...value(), value: 'NaN' },
    { ...value(), value: 'Infinity' },
    { ...value(), unit: '' },
    { ...value(), role: 'PROJECT_MANAGER' },
    { state: 'missing', raw: '0', unit: 'mm', reason: 'missing' },
    { state: 'blank', raw: null, unit: null, reason: 'blank' },
  ])('rejects malformed values without normalization', (input) => {
    expect(() => parseWeatherValue(input)).toThrow();
  });
  it('retains the declared business date rather than the later fetch/receipt date', () => {
    const q = parseWeatherQuery(query(), '2026-10-09T12:00:00Z');
    expect(q.businessDate).toBe('2026-10-05');
    expect(q.interval).toEqual(query().interval);
  });
  it.each([
    ['2026-03-29', '2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z', 23],
    ['2026-10-25', '2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z', 25],
  ] as const)(
    'accepts the %s local-day DST interval',
    (day, startAt, endAt, hours) => {
      const q = parseWeatherQuery(
        { ...query(), businessDate: day, interval: { startAt, endAt } },
        '2026-12-01T00:00:00Z',
      );
      expect(
        (Date.parse(q.interval.endAt) - Date.parse(q.interval.startAt)) /
          3600000,
      ).toBe(hours);
    },
  );
  it('rejects a forced 24-hour window on the 25-hour day', () => {
    expect(() =>
      parseWeatherQuery(
        {
          ...query(),
          businessDate: '2026-10-25',
          interval: {
            startAt: '2026-10-24T22:00:00Z',
            endAt: '2026-10-25T22:00:00Z',
          },
        },
        '2026-12-01T00:00:00Z',
      ),
    ).toThrow();
  });
  it.each([
    { ...query(), businessDate: '2026-02-30' },
    { ...query(), timezone: 'TEST/Invalid' },
    { ...query(), point: { lat: '91', lon: '19' } },
    { ...query(), point: { lat: '', lon: '19' } },
    { ...query(), orgId: 'forged' },
    { ...query(), product: 'forecast', model: 'forecast' },
    { ...query(), model: 'forecast' },
  ])(
    'rejects malformed or historical-current substitution queries',
    (input) => {
      expect(() => parseWeatherQuery(input, now)).toThrow();
    },
  );
  it('does not label an uncompleted day historical', () => {
    const input = {
      ...query(),
      businessDate: '2026-10-06',
      interval: {
        startAt: '2026-10-05T22:00:00Z',
        endAt: '2026-10-06T22:00:00Z',
      },
    };
    expect(() => parseWeatherQuery(input, now)).toThrow();
    expect(
      weatherCategory(
        parseWeatherQuery(
          { ...input, product: 'forecast', model: 'forecast' },
          now,
        ),
      ),
    ).toBe('forecast');
  });
  it('keeps publication unknown and fetch time separate without modifying input', () => {
    const input = reference();
    const before = structuredClone(input);
    const r = parseWeatherReferenceDraft(input);
    expect(r.publishedAt).toBeNull();
    expect(r.fetchedAt).toBe(now);
    expect(input).toEqual(before);
  });
  it('rejects a reanalysis being presented as observation or analysis', () => {
    for (const category of ['observation', 'analysis', 'forecast'])
      expect(() =>
        parseWeatherReferenceDraft({ ...reference(), category }),
      ).toThrow();
  });
  it('missing metrics cannot be called complete coverage', () => {
    const input = reference();
    input.metrics['gustMax'] = {
      state: 'missing',
      raw: null,
      unit: 'm/s',
      reason: 'provider_null',
    };
    expect(() => parseWeatherReferenceDraft(input)).toThrow();
    expect(
      parseWeatherReferenceDraft({ ...input, coverage: 'partial' }).metrics
        .gustMax.state,
    ).toBe('missing');
  });
  it('accepts only weather fields, never safety or work authorization', () => {
    expect(() =>
      parseWeatherReferenceDraft({ ...reference(), safeToWork: true }),
    ).toThrow();
    expect(() =>
      parseWeatherReferenceDraft({ ...reference(), downtimeMinutes: 480 }),
    ).toThrow();
  });
  it('keeps unknown device time separate from acquisition time', () => {
    const input = {
      ...query().point,
      accuracyM: '100.00',
      deviceFixAt: null,
      acquiredAt: now,
    };
    expect(parseReportLocationCandidate(input)).toEqual(input);
    expect(() =>
      parseReportLocationCandidate({ ...input, serverReceivedAt: now }),
    ).toThrow();
    expect(() =>
      parseReportLocationCandidate({ ...input, accuracyM: '-1' }),
    ).toThrow();
    expect(() =>
      parseReportLocationCandidate({ ...input, deviceFixAt: 'yesterday' }),
    ).toThrow();
  });
});
