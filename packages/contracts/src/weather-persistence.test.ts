import { describe, expect, it } from 'vitest';
import {
  buildWeatherQuery,
  parseConfigureWeatherLocationCommand,
  parseReportLocationOperation,
  parseWeatherFactsExtension,
  parseWeatherRequestCommand,
  weatherDayInterval,
} from './weather-persistence.js';
const a = '00000000-0000-4000-8000-000000000001',
  b = '00000000-0000-4000-8000-000000000002';
// Synthetic TEST points only.
describe('persistence boundary', () => {
  it('preserves omitted extensions versus explicit clear', () => {
    expect(parseWeatherFactsExtension({})).toEqual({});
    expect(
      parseWeatherFactsExtension({
        weatherReferences: [],
        reportLocationRef: null,
      }),
    ).toEqual({ weatherReferences: [], reportLocationRef: null });
  });
  it.each(['lat', 'actorAccountId', 'orgId', 'serverReceivedAt'])(
    'rejects %s in reference input',
    (key) => {
      expect(() =>
        parseWeatherFactsExtension({
          weatherReferences: [
            { locationVersionId: a, snapshotId: b, [key]: 'TEST' },
          ],
        }),
      ).toThrow();
    },
  );
  it('rejects duplicates and too many references', () => {
    const r = { locationVersionId: a, snapshotId: b };
    expect(() =>
      parseWeatherFactsExtension({ weatherReferences: [r, r] }),
    ).toThrow();
    expect(() =>
      parseWeatherFactsExtension({ weatherReferences: Array(21).fill(r) }),
    ).toThrow();
  });
  it('preserves deliberate capture and forbids spoofed receipt time', () => {
    const v = {
      kind: 'capture',
      candidate: {
        lat: '45.123456789012',
        lon: '019.0',
        accuracyM: '200.00',
        deviceFixAt: null,
        acquiredAt: '2026-10-06T12:00:00Z',
      },
      clientConfirmedAt: '2026-10-06T12:00:01Z',
    };
    expect(parseReportLocationOperation(v)).toEqual(v);
    expect(() =>
      parseReportLocationOperation({ ...v, serverReceivedAt: 'TEST' }),
    ).toThrow();
    expect(parseReportLocationOperation({ kind: 'clear' })).toEqual({
      kind: 'clear',
    });
  });
  it('keeps purpose config apart from geofence and personal point', () => {
    const v = {
      projectId: a,
      scopeKey: 'TEST-site',
      expectedN: 0,
      clientMutationId: b,
      point: { lat: '45.123456789012', lon: '19.0' },
    };
    expect(parseConfigureWeatherLocationCommand(v)).toEqual(v);
    expect(() =>
      parseConfigureWeatherLocationCommand({ ...v, radiusM: 100 }),
    ).toThrow();
  });
  it('only accepts server-routed request identifiers', () => {
    const v = {
      projectId: a,
      locationVersionId: b,
      businessDate: '2026-10-05',
      refresh: false,
      clientMutationId: a,
    };
    expect(parseWeatherRequestCommand(v)).toEqual(v);
    expect(() =>
      parseWeatherRequestCommand({ ...v, point: { lat: '1', lon: '2' } }),
    ).toThrow();
    expect(() =>
      parseWeatherRequestCommand({ ...v, model: 'forecast' }),
    ).toThrow();
  });
  it.each([
    ['2026-03-29', 23],
    ['2026-10-25', 25],
  ] as const)(
    'constructs %s as actual local civil-day length',
    (day, hours) => {
      const i = weatherDayInterval(day, 'Europe/Belgrade');
      expect(Date.parse(i.endAt) - Date.parse(i.startAt)).toBe(hours * 3600000);
    },
  );
  it('fails invalid timezone, skipped date and invalid calendar', () => {
    expect(() => weatherDayInterval('2026-02-30', 'UTC')).toThrow();
    expect(() => weatherDayInterval('2011-12-30', 'Pacific/Apia')).toThrow();
    expect(() => weatherDayInterval('2026-10-05', 'TEST/invalid')).toThrow();
  });
  it('routes a past day using site coordinates even when received later', () => {
    const q = buildWeatherQuery(
      {
        id: b,
        projectId: a,
        scopeKey: 'TEST',
        n: 1,
        siteTimezone: 'Europe/Belgrade',
        point: { lat: '45.123456789012', lon: '19' },
        confirmedAt: '2026-10-06T12:00:00Z',
      },
      '2026-10-05',
      '2026-10-06T12:00:00Z',
    );
    expect(q.product).toBe('historical-weather');
    expect(q.point.lat).toBe('45.123456789012');
  });
});
