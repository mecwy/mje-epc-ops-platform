import { describe, expect, it, vi } from 'vitest';
import {
  WEATHER_METRICS,
  type SafeFrozenWeatherReference,
} from '@mje/contracts';
import {
  disabledWeatherPorts,
  locateReportLocation,
  parseFrozenWeatherReferences,
  reportLocationReading,
  weatherReferenceView,
} from './weather-adapter.js';
import { toFix, type GeoSource } from './geo.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function frozen(): SafeFrozenWeatherReference {
  return {
    referenceId: id(1),
    snapshotId: id(2),
    locationVersionId: id(3),
    adoptedAt: '2026-10-06T12:00:00Z',
    adoptedByAccountId: id(4),
    adoptedByPersonId: id(5),
    adapterVersion: 'TEST-v1',
    responseHash: 'TEST-hash',
    sourceLink: 'https://example.test/weather',
    licenseLink: 'https://example.test/license',
    snapshot: {
      provider: 'open-meteo',
      query: {
        projectId: id(6),
        locationVersionId: id(3),
        businessDate: '2026-10-05',
        timezone: 'UTC',
        point: { lat: '1', lon: '1' },
        interval: {
          startAt: '2026-10-05T00:00:00Z',
          endAt: '2026-10-06T00:00:00Z',
        },
        product: 'historical-weather',
        model: 'era5',
      },
      category: 'reanalysis',
      fetchedAt: '2026-10-06T10:00:00Z',
      publishedAt: null,
      coverage: 'partial',
      grid: null,
      metrics: Object.fromEntries(
        WEATHER_METRICS.map((key) => [
          key,
          key === 'precipitation'
            ? { state: 'value', value: '0', raw: '0', unit: 'mm' }
            : {
                state: 'missing',
                raw: null,
                unit: null,
                reason: 'TEST missing',
              },
        ]),
      ) as SafeFrozenWeatherReference['snapshot']['metrics'],
    },
  };
}
const reading = (latitude: number, accuracy = 25.12, timestamp = 0) => ({
  coords: { latitude, longitude: -180, accuracy },
  timestamp,
});
describe('C03 raw decoding and bounded acquisition', () => {
  it('retains twelve coordinate decimals and unknown device time without changing old check-in conversion', () => {
    const candidate = reportLocationReading(reading(0.123456789012), 1000);
    expect(candidate).toEqual({
      lat: '0.123456789012',
      lon: '-180',
      accuracyM: '25.12',
      deviceFixAt: null,
      acquiredAt: '1970-01-01T00:00:01.000Z',
    });
    expect(toFix(reading(0.123456789012).coords, 0, 1000)).toEqual({
      lat: '0.123457',
      lon: '-180.000000',
      accuracyM: '25.12',
      fixAt: '1970-01-01T00:00:01.000Z',
    });
    expect(reportLocationReading(reading(1e-7), 1000)?.lat).toBe('0.0000001');
    expect(reportLocationReading(reading(-90), 1000)?.lat).toBe('-90');
  });
  it.each([reading(91), reading(NaN), reading(1, -1)])(
    'rejects invalid readings instead of rounding',
    (input) => {
      expect(reportLocationReading(input, 1000)).toBeNull();
    },
  );
  it.each([
    reading(45.12345678901234, 12.34),
    reading(45.123456, 12.345678),
    reading(Number.MIN_VALUE, 0),
    reading(-0, -0),
  ])(
    'retains native precision through the actual report decoder %#',
    (input) => {
      const decoded = reportLocationReading(input, 1000);
      expect(decoded).not.toBeNull();
      expect(decoded?.deviceFixAt).toBeNull();
      expect(Number(decoded?.lat)).toBe(input.coords.latitude);
      expect(Number(decoded?.accuracyM)).toBe(input.coords.accuracy);
      if (input.coords.latitude === 45.12345678901234)
        expect(decoded?.lat).toBe('45.12345678901234');
      if (input.coords.accuracy === 12.345678)
        expect(decoded?.accuracyM).toBe('12.345678');
      if (Object.is(input.coords.latitude, -0)) expect(decoded?.lat).toBe('-0');
    },
  );
  it('aborts the injected watch and never accepts a later reading', async () => {
    let success!: Parameters<GeoSource['watchPosition']>[0];
    const geo: GeoSource = {
      watchPosition: vi.fn((fn) => {
        success = fn;
        return 42;
      }),
      clearWatch: vi.fn(),
    };
    const controller = new AbortController();
    const pending = locateReportLocation(geo, controller.signal);
    controller.abort();
    success(reading(1));
    expect(await pending).toEqual({ kind: 'unavailable' });
    expect(geo.clearWatch).toHaveBeenCalledWith(42);
  });
  it('default ports do not request a location or provider', async () => {
    expect(await disabledWeatherPorts.locate()).toEqual({
      kind: 'unsupported',
    });
    await expect(disabledWeatherPorts.loadWeather()).rejects.toThrow(
      'WEATHER_DISABLED',
    );
  });
});
describe('frozen weather response boundary', () => {
  it('retains zero, missing and the exact frozen provenance', () => {
    const reference = frozen();
    expect(
      parseFrozenWeatherReferences([reference], id(6), '2026-10-05'),
    ).toEqual([reference]);
    const view = weatherReferenceView(reference);
    expect(view.values.find((v) => v.label === 'precipitation')).toMatchObject({
      state: 'value',
      value: '0',
    });
    expect(view.values.find((v) => v.label === 'windMax')).toMatchObject({
      state: 'missing',
      value: null,
    });
  });
  it('rejects wrapper raw coordinates, another day and malformed snapshot metadata', () => {
    expect(() =>
      parseFrozenWeatherReferences([{ ...frozen(), lat: '1' }]),
    ).toThrow();
    expect(() =>
      parseFrozenWeatherReferences([frozen()], id(6), '2026-10-04'),
    ).toThrow();
    expect(() =>
      parseFrozenWeatherReferences([{ ...frozen(), adoptedAt: 'unknown' }]),
    ).toThrow();
    const other = frozen();
    other.snapshot.query.locationVersionId = id(9);
    expect(() => parseFrozenWeatherReferences([other])).toThrow();
  });
});
