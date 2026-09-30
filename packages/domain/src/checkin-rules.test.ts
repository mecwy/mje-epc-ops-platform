import { describe, expect, it } from 'vitest';
import {
  admitDeviceTimes,
  distanceBucket,
  fence,
  localDate,
  proxyLocationFlags,
} from './checkin-rules.js';
import { daysBetween } from './report-rules.js';

const at = (s: string) => new Date(s);
const base = {
  occurredAt: at('2026-10-05T08:00:00Z'),
  fixAt: at('2026-10-05T07:59:30Z'),
  deviceSentAt: at('2026-10-05T08:00:05Z'),
  receivedAt: at('2026-10-05T08:00:06Z'),
  businessDate: '2026-10-05',
  timeZone: 'UTC',
};
const ref = { n: 1, lat: 0, lon: 0, radiusM: 500 };
/** Degrees of latitude for a distance in metres (haversine, R = 6 371 km). */
const north = (m: number) => (m / 6_371_000) * (180 / Math.PI);

describe('check-in time admission (T1–T5)', () => {
  it('accepts a fresh tap and flags LATE only after 15 minutes', () => {
    expect(admitDeviceTimes(base)).toEqual({ ok: true, flags: [] });
    const late = {
      ...base,
      deviceSentAt: at('2026-10-05T08:15:01Z'),
      receivedAt: at('2026-10-05T08:15:02Z'),
    };
    expect(admitDeviceTimes(late)).toEqual({ ok: true, flags: ['LATE'] });
  });
  it('refuses a fix from the future or staler than 2 minutes (T1)', () => {
    for (const fixAt of ['2026-10-05T08:00:01Z', '2026-10-05T07:57:59Z'])
      expect(admitDeviceTimes({ ...base, fixAt: at(fixAt) })).toEqual({
        ok: false,
        code: 'FIX_TIME_INVALID',
      });
  });
  it('refuses occurredAt after deviceSentAt (T2) and a skew beyond 5 minutes either way (T3)', () => {
    expect(
      admitDeviceTimes({ ...base, deviceSentAt: at('2026-10-05T07:59:59Z') }),
    ).toEqual({ ok: false, code: 'TIME_ORDER_INVALID' });
    for (const receivedAt of ['2026-10-05T08:06:06Z', '2026-10-05T07:54:04Z'])
      expect(admitDeviceTimes({ ...base, receivedAt: at(receivedAt) })).toEqual(
        { ok: false, code: 'DEVICE_CLOCK_SKEW' },
      );
  });
  it('refuses a first attempt older than 24 hours (T4)', () => {
    expect(
      admitDeviceTimes({
        ...base,
        deviceSentAt: at('2026-10-06T08:00:01Z'),
        receivedAt: at('2026-10-06T08:00:02Z'),
      }),
    ).toEqual({ ok: false, code: 'TOO_LATE' });
  });
  it('derives the business day in the site zone: 23:59 / 00:00 and both DST changes (T5)', () => {
    const tz = 'Europe/Belgrade';
    // 23:59:30 and 00:00:30 local (UTC+2 in summer).
    expect(localDate(at('2026-10-04T21:59:30Z'), tz)).toBe('2026-10-04');
    expect(localDate(at('2026-10-04T22:00:30Z'), tz)).toBe('2026-10-05');
    // Autumn: 2026-10-25 03:00 CEST → 02:00 CET; local midnight is 22:00Z before, 23:00Z after.
    expect(localDate(at('2026-10-25T22:59:59Z'), tz)).toBe('2026-10-25');
    expect(localDate(at('2026-10-25T23:00:00Z'), tz)).toBe('2026-10-26');
    // Spring: 2026-03-29 02:00 CET → 03:00 CEST; a tap at 01:30Z is 03:30 local, same day.
    expect(localDate(at('2026-03-29T01:30:00Z'), tz)).toBe('2026-03-29');
    expect(localDate(at('2026-03-28T22:59:59Z'), tz)).toBe('2026-03-28');
    const edge = {
      ...base,
      timeZone: tz,
      occurredAt: at('2026-10-25T22:59:59Z'),
      fixAt: at('2026-10-25T22:59:50Z'),
      deviceSentAt: at('2026-10-25T23:00:01Z'),
      receivedAt: at('2026-10-25T23:00:02Z'),
    };
    expect(admitDeviceTimes({ ...edge, businessDate: '2026-10-25' }).ok).toBe(
      true,
    );
    // The client's date is never taken over the server-derived one.
    expect(admitDeviceTimes({ ...edge, businessDate: '2026-10-26' })).toEqual({
      ok: false,
      code: 'BUSINESS_DAY_MISMATCH',
    });
    expect(daysBetween('2026-10-24', '2026-10-31')).toBe(7);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
  });
});

describe('geofence', () => {
  it('refuses coarse accuracy, outside the radius and a missing reference (never distance 0)', () => {
    const inside = { lat: north(300), lon: 0, accuracyM: 20 };
    expect(fence(inside, ref)).toMatchObject({ ok: true, flags: [] });
    expect(fence({ ...inside, accuracyM: 100.01 }, ref)).toMatchObject({
      ok: false,
      code: 'LOCATION_TOO_COARSE',
    });
    expect(fence({ ...inside, lat: north(510) }, ref)).toMatchObject({
      ok: false,
      code: 'GEOFENCE_OUTSIDE',
    });
    expect(fence(inside, null)).toEqual({
      ok: false,
      code: 'SITE_NOT_CONFIGURED',
      distanceM: null,
    });
    expect(fence({ ...inside, lat: Number.NaN }, ref)).toMatchObject({
      ok: false,
      code: 'LOCATION_TOO_COARSE',
      distanceM: null,
    });
  });
  it('flags NEAR_EDGE when distance + accuracy exceeds the radius; the edge itself is inside', () => {
    expect(
      fence({ lat: north(450), lon: 0, accuracyM: 60 }, ref),
    ).toMatchObject({
      ok: true,
      flags: ['NEAR_EDGE'],
    });
    expect(
      fence({ lat: north(499.9), lon: 0, accuracyM: 0 }, ref),
    ).toMatchObject({ ok: true, flags: [] });
    expect(distanceBucket(512.7)).toBe(500);
    expect(distanceBucket(99.9)).toBe(0);
  });
  it('a PM proxy fix only yields flags', () => {
    expect(proxyLocationFlags(null, ref).flags).toEqual([
      'PROXY_LOCATION_UNAVAILABLE',
    ]);
    expect(
      proxyLocationFlags({ lat: north(100), lon: 0, accuracyM: 10 }, null)
        .flags,
    ).toEqual(['PROXY_LOCATION_UNAVAILABLE']);
    expect(
      proxyLocationFlags({ lat: north(100), lon: 0, accuracyM: 10 }, ref).flags,
    ).toEqual([]);
    expect(
      proxyLocationFlags({ lat: north(5000), lon: 0, accuracyM: 50 }, ref)
        .flags,
    ).toEqual(['REMOTE_PROXY']);
    expect(
      proxyLocationFlags({ lat: north(100), lon: 0, accuracyM: 150 }, ref)
        .flags,
    ).toEqual(['PROXY_LOCATION_COARSE']);
    // Outside but within its accuracy: ambiguous.
    expect(
      proxyLocationFlags({ lat: north(550), lon: 0, accuracyM: 80 }, ref).flags,
    ).toEqual(['PROXY_LOCATION_COARSE']);
  });
});
