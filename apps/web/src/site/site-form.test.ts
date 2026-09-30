import { describe, expect, it } from 'vitest';
import type { FieldDeviceDto } from '@mje/contracts';
import { parseSiteReferenceCommand } from '@mje/contracts';
import {
  checkProxyDays,
  checkSite,
  currentDevice,
  groupDevices,
} from './site-form.js';

// TEST coordinates only (never a real site).
describe('site location form', () => {
  it('accepts coordinates as typed and a whole radius of 50–2000 m', () => {
    const ok = checkSite({ lat: ' 1.0 ', lon: '-1,000001', radius: '500' });
    expect(ok).toEqual({
      ok: true,
      lat: '1.0',
      lon: '-1.000001',
      radiusM: 500,
    });
    expect(checkSite({ lat: '90', lon: '180', radius: '50' }).ok).toBe(true);
    expect(checkSite({ lat: '-90', lon: '-180', radius: '2000' }).ok).toBe(
      true,
    );
    // The command is exactly what the server's contract accepts.
    if (ok.ok)
      expect(
        parseSiteReferenceCommand({
          projectId: '11111111-1111-4111-8111-111111111111',
          clientMutationId: '22222222-2222-4222-8222-222222222222',
          expectedN: 0,
          lat: ok.lat,
          lon: ok.lon,
          radiusM: ok.radiusM,
        }).lat,
      ).toBe('1.0');
  });
  it('names each problem instead of correcting the value', () => {
    expect(checkSite({ lat: '', lon: '1', radius: '' })).toEqual({
      ok: false,
      problems: { lat: 'required', radius: 'required' },
    });
    // More than 6 decimals is refused, never rounded or cut.
    expect(checkSite({ lat: '1.1234567', lon: '1', radius: '500' })).toEqual({
      ok: false,
      problems: { lat: 'decimals' },
    });
    expect(
      checkSite({ lat: '90.000001', lon: '180.1', radius: '500' }),
    ).toEqual({
      ok: false,
      problems: { lat: 'range', lon: 'range' },
    });
    expect(checkSite({ lat: '1e2', lon: 'NaN', radius: '500' })).toEqual({
      ok: false,
      problems: { lat: 'format', lon: 'format' },
    });
    for (const radius of ['49', '2001', '0'])
      expect(checkSite({ lat: '1', lon: '1', radius })).toEqual({
        ok: false,
        problems: { radius: 'range' },
      });
    for (const radius of ['500.5', '-50', '5e2'])
      expect(checkSite({ lat: '1', lon: '1', radius })).toEqual({
        ok: false,
        problems: { radius: 'format' },
      });
  });
  it('takes PM proxy days 1–30 as a whole number only', () => {
    expect(checkProxyDays('1')).toBe(1);
    expect(checkProxyDays(' 30 ')).toBe(30);
    for (const bad of ['0', '31', '7.5', '', 'x', '-1'])
      expect(checkProxyDays(bad)).toBeNull();
  });
});

const device = (
  id: string,
  personId: string,
  effectiveState: FieldDeviceDto['effectiveState'],
): FieldDeviceDto => ({
  id,
  personId,
  displayName: `TEST ${personId}`,
  state: effectiveState === 'EXPIRED' ? 'CONFIRMED' : effectiveState,
  effectiveState,
  endReason: null,
  version: 1,
  createdAt: '2026-10-01T08:00:00.000Z',
  confirmedAt: null,
  confirmedBy: null,
  lastSeenAt: '2026-10-01T08:00:00.000Z',
  expiresAt: '2027-03-30T08:00:00.000Z',
  memberUntil: null,
});
describe('PM device list', () => {
  const list = [
    device('d4', 'p1', 'PENDING'),
    device('d3', 'p1', 'EXPIRED'),
    device('d2', 'p2', 'CONFIRMED'),
    device('d1', 'p1', 'REVOKED'),
  ];
  it('groups by the state the timestamps imply now, keeping the server order', () => {
    const g = groupDevices(list);
    expect(g.pending.map((d) => d.id)).toEqual(['d4']);
    expect(g.active.map((d) => d.id)).toEqual(['d2']);
    // A stored CONFIRMED device past its deadline is ended, never shown as active.
    expect(g.ended.map((d) => d.id)).toEqual(['d3', 'd1']);
  });
  it('sends the current confirmed device as seen, or null when there is none', () => {
    expect(currentDevice(list, 'p2')).toBe('d2');
    // p1's stored-confirmed device has lapsed: the server also treats it as none.
    expect(currentDevice(list, 'p1')).toBeNull();
    expect(currentDevice([], 'p1')).toBeNull();
  });
});
