import { describe, expect, it } from 'vitest';
import {
  GOOD_ACCURACY_M,
  MAX_LOCATE_MS,
  locate,
  toFix,
  type GeoSource,
  type Timers,
} from './geo.js';

/** A device whose position readings and clock the test drives. */
function device() {
  let success: Parameters<GeoSource['watchPosition']>[0] = () => undefined;
  let error: Parameters<GeoSource['watchPosition']>[1] = () => undefined;
  let options: PositionOptions | null = null;
  const cleared: number[] = [];
  let timer: (() => void) | null = null;
  let now = Date.parse('2026-10-01T08:00:00.000Z');
  const geo: GeoSource = {
    watchPosition: (s, e, o) => {
      success = s;
      error = e;
      options = o;
      return 7;
    },
    clearWatch: (id) => cleared.push(id),
  };
  const timers: Timers = {
    set: (fn, ms) => {
      expect(ms).toBe(MAX_LOCATE_MS);
      timer = fn;
      return 1;
    },
    clear: () => (timer = null),
    now: () => now,
  };
  // TEST coordinates only (not a real site).
  const read = (accuracy: number, at = now, lat = 10.5, lon = -20.25) =>
    success({
      coords: { latitude: lat, longitude: lon, accuracy },
      timestamp: at,
    });
  return {
    geo,
    timers,
    read,
    fail: (code: number) => error({ code }),
    expire: () => timer?.(),
    cleared,
    options: () => options,
    advance: (ms: number) => (now += ms),
  };
}

describe('device fix', () => {
  it('keeps refreshing and stops early once the fix is within 30 m', async () => {
    const d = device();
    const got = locate(d.geo, d.timers);
    d.read(250);
    d.advance(1500);
    d.read(80);
    d.advance(1500);
    d.read(GOOD_ACCURACY_M, Date.parse('2026-10-01T08:00:03.000Z'));
    const r = await got;
    expect(r.fix).toEqual({
      lat: '10.500000',
      lon: '-20.250000',
      accuracyM: '30.00',
      fixAt: '2026-10-01T08:00:03.000Z',
    });
    expect(d.cleared).toEqual([7]);
    expect(d.options()).toMatchObject({
      enableHighAccuracy: true,
      maximumAge: 0,
    });
  });

  it('after 8 s takes the best fix seen, with that fix’s own time', async () => {
    const d = device();
    const got = locate(d.geo, d.timers);
    d.read(90, Date.parse('2026-10-01T08:00:01.000Z'));
    d.read(45, Date.parse('2026-10-01T08:00:04.000Z'));
    d.read(120, Date.parse('2026-10-01T08:00:06.000Z'));
    d.fail(3); // a timeout while watching is waited out
    d.expire();
    const r = await got;
    expect(r.fix).toMatchObject({
      accuracyM: '45.00',
      fixAt: '2026-10-01T08:00:04.000Z',
    });
    expect(d.cleared).toEqual([7]);
  });

  it('no fix is no fix: refused permission ends at once, otherwise after 8 s', async () => {
    const denied = device();
    const a = locate(denied.geo, denied.timers);
    denied.fail(1);
    expect(await a).toEqual({ fix: null, reason: 'denied' });
    const silent = device();
    const b = locate(silent.geo, silent.timers);
    silent.fail(2);
    silent.expire();
    expect(await b).toEqual({ fix: null, reason: 'noFix' });
    expect(await locate(null)).toEqual({ fix: null, reason: 'unsupported' });
  });

  it('an unusable reading is ignored rather than rounded or clamped into a fix', () => {
    const now = Date.parse('2026-10-01T08:00:00.000Z');
    const c = (latitude: number, longitude: number, accuracy: number) => ({
      latitude,
      longitude,
      accuracy,
    });
    expect(toFix(c(NaN, 1, 5), now, now)).toBeNull();
    expect(toFix(c(1, 1, NaN), now, now)).toBeNull();
    expect(toFix(c(91, 1, 5), now, now)).toBeNull();
    expect(toFix(c(1, 181, 5), now, now)).toBeNull();
    expect(toFix(c(1, 1, -1), now, now)).toBeNull();
    expect(toFix(c(1, 1, 1_000_000), now, now)).toBeNull();
    // The accuracy is sent as measured (2 decimals), not rounded to a nicer number.
    expect(toFix(c(1.23456789, -0.5, 12.345), now, now)).toEqual({
      lat: '1.234568',
      lon: '-0.500000',
      accuracyM: '12.35',
      fixAt: '2026-10-01T08:00:00.000Z',
    });
    // A missing device timestamp falls back to when the reading arrived.
    expect(toFix(c(1, 1, 5), 0, now + 5)?.fixAt).toBe(
      '2026-10-01T08:00:00.005Z',
    );
  });
});
