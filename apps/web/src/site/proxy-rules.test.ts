import { describe, expect, it } from 'vitest';
import type { RosterDto } from '@mje/contracts';
import { parsePmProxyCheckInCommand } from '@mje/contracts';
import {
  checkProxy,
  membersOfDay,
  proxyDays,
  siteInstant,
} from './proxy-rules.js';

const TZ = 'Europe/Belgrade';
const P = '11111111-1111-4111-8111-111111111111';
const W = '22222222-2222-4222-8222-222222222222';
const base = {
  projectId: P,
  today: '2026-10-02',
  pmProxyDays: 7,
  timeZone: TZ,
  now: Date.parse('2026-10-02T10:00:00.000Z'),
};
const form = {
  personId: W,
  businessDate: '2026-10-02',
  time: '',
  source: 'OBSERVED_ON_SITE' as const,
  reason: '',
  // TEST coordinates only.
  actorFix: {
    lat: '1.000000',
    lon: '1.000000',
    accuracyM: '20.00',
    fixAt: '2026-10-02T09:59:00.000Z',
  },
};

describe('PM proxy check-in rules', () => {
  it('converts site times with the tz database (DST gap refused, never moved)', () => {
    expect(siteInstant('2026-10-02', '08:30', TZ)).toBe(
      '2026-10-02T06:30:00.000Z',
    );
    expect(siteInstant('2026-01-15', '08:30', TZ)).toBe(
      '2026-01-15T07:30:00.000Z',
    );
    expect(siteInstant('2026-03-29', '02:30', TZ)).toBeNull();
    expect(siteInstant('2026-03-29', '03:30', TZ)).toBe(
      '2026-03-29T01:30:00.000Z',
    );
    expect(siteInstant('2026-10-02', '24:00', TZ)).toBeNull();
  });
  it('offers the site today back to the project lookback', () => {
    expect(proxyDays('2026-10-02', 2)).toEqual([
      '2026-10-02',
      '2026-10-01',
      '2026-09-30',
    ]);
  });
  it('without a time the check-in is DAY precision (occurredAt null, nothing invented)', () => {
    const r = checkProxy(form, base);
    expect(r).toMatchObject({
      ok: true,
      command: { occurredAt: null, reason: '' },
    });
    if (r.ok)
      expect(
        parsePmProxyCheckInCommand({
          ...r.command,
          clientMutationId: '33333333-3333-4333-8333-333333333333',
        }).occurredAt,
      ).toBeNull();
  });
  it('an exact time is the site-local instant and may not be in the future', () => {
    expect(checkProxy({ ...form, time: '07:15' }, base)).toMatchObject({
      ok: true,
      command: { occurredAt: '2026-10-02T05:15:00.000Z' },
    });
    expect(checkProxy({ ...form, time: '13:00' }, base)).toEqual({
      ok: false,
      problem: 'future',
    });
  });
  it('the date must be within the lookback; another day or no PM location needs a reason', () => {
    expect(checkProxy({ ...form, businessDate: '2026-09-24' }, base)).toEqual({
      ok: false,
      problem: 'date',
    });
    expect(checkProxy({ ...form, businessDate: '2026-10-03' }, base)).toEqual({
      ok: false,
      problem: 'date',
    });
    expect(checkProxy({ ...form, businessDate: '2026-09-25' }, base)).toEqual({
      ok: false,
      problem: 'reason',
    });
    expect(checkProxy({ ...form, actorFix: null }, base)).toEqual({
      ok: false,
      problem: 'reason',
    });
    expect(
      checkProxy(
        { ...form, actorFix: null, reason: 'TEST told by foreman' },
        base,
      ).ok,
    ).toBe(true);
    expect(checkProxy({ ...form, personId: '' }, base)).toEqual({
      ok: false,
      problem: 'person',
    });
  });
  it('names anyone rostered as a member that site day, including people who left since', () => {
    const roster: RosterDto = {
      projectId: P,
      rosterVersion: 3,
      crews: [],
      assignments: [
        {
          id: 'a1',
          crewId: 'c',
          personId: 'p1',
          displayName: 'TEST One',
          role: 'MEMBER',
          validFrom: '2026-09-01T00:00:00.000Z',
          validUntil: null,
        },
        // left at noon on the day: still named for that day
        {
          id: 'a2',
          crewId: 'c',
          personId: 'p2',
          displayName: 'TEST Two',
          role: 'MEMBER',
          validFrom: '2026-09-01T00:00:00.000Z',
          validUntil: '2026-10-02T10:00:00.000Z',
        },
        // left the day before (site midnight is 22:00 UTC)
        {
          id: 'a3',
          crewId: 'c',
          personId: 'p3',
          displayName: 'TEST Three',
          role: 'MEMBER',
          validFrom: '2026-09-01T00:00:00.000Z',
          validUntil: '2026-10-01T21:59:00.000Z',
        },
        // joined the day after
        {
          id: 'a4',
          crewId: 'c',
          personId: 'p4',
          displayName: 'TEST Four',
          role: 'MEMBER',
          validFrom: '2026-10-02T22:00:00.000Z',
          validUntil: null,
        },
        {
          id: 'a5',
          crewId: 'c',
          personId: 'p5',
          displayName: 'TEST Five',
          role: 'FOREMAN',
          validFrom: '2026-09-01T00:00:00.000Z',
          validUntil: null,
        },
      ],
    };
    expect(
      membersOfDay(roster, '2026-10-02', TZ).map((m) => m.personId),
    ).toEqual(['p1', 'p2']);
  });
});
