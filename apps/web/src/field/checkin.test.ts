import { describe, expect, it } from 'vitest';
import type { CaptureFixDto } from '@mje/contracts';
import { parseCheckInCommand } from '@mje/contracts';
import {
  attempt,
  checkFix,
  checkInEvent,
  recallToday,
  rememberToday,
} from './checkin.js';

// TEST coordinates only (never a real site).
const fix = (o: Partial<CaptureFixDto> = {}): CaptureFixDto => ({
  lat: '1.000000',
  lon: '1.000000',
  accuracyM: '20.00',
  fixAt: '2026-10-02T08:00:00.000Z',
  ...o,
});
const at = (iso: string) => Date.parse(iso);

describe('check-in rules on the phone', () => {
  it('sends a fix only within 100 m accuracy and 2 minutes of age', () => {
    const now = at('2026-10-02T08:00:30.000Z');
    expect(checkFix(fix({ accuracyM: '100.00' }), now)).toBe('ok');
    expect(checkFix(fix({ accuracyM: '100.01' }), now)).toBe('coarse');
    expect(checkFix(fix(), at('2026-10-02T08:02:00.000Z'))).toBe('ok');
    expect(checkFix(fix(), at('2026-10-02T08:02:00.001Z'))).toBe('stale');
  });
  it('takes occurredAt no earlier than the fix and the business date on the site clock', () => {
    // 23:30 UTC is 01:30 the next day in Belgrade (summer time): the site date, not UTC's.
    const f = fix({ fixAt: '2026-10-02T23:30:00.000Z' });
    const e = checkInEvent(
      f,
      'Europe/Belgrade',
      at('2026-10-02T23:30:05.000Z'),
      null,
    );
    expect(e.businessDate).toBe('2026-10-03');
    expect(e.occurredAt).toBe('2026-10-02T23:30:05.000Z');
    // A fix stamped slightly ahead of the phone clock: occurredAt is the fix time (T1).
    const ahead = checkInEvent(
      fix({ fixAt: '2026-10-02T08:00:02.000Z' }),
      'Europe/Belgrade',
      at('2026-10-02T08:00:00.000Z'),
      null,
    );
    expect(ahead.occurredAt).toBe('2026-10-02T08:00:02.000Z');
  });
  it('keeps the key and event across attempts; only deviceSentAt moves, never before occurredAt', () => {
    const e = checkInEvent(
      fix(),
      'Europe/Belgrade',
      at('2026-10-02T08:00:10.000Z'),
      null,
    );
    const key = '55555555-5555-4555-8555-555555555555';
    const a1 = attempt(key, e, at('2026-10-02T08:00:05.000Z'));
    const a2 = attempt(key, e, at('2026-10-03T09:00:00.000Z'));
    expect(a1.deviceSentAt).toBe(e.occurredAt);
    expect(a2.deviceSentAt).toBe('2026-10-03T09:00:00.000Z');
    const { deviceSentAt: _1, ...event1 } = a1;
    const { deviceSentAt: _2, ...event2 } = a2;
    expect(event1).toEqual(event2);
    // The command is exactly what the server's contract accepts.
    expect(parseCheckInCommand(a2)).toEqual(a2);
  });
  it('remembers today’s check-in per device and site day only', () => {
    const m = new Map<string, string>();
    const s = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    } as Storage;
    const today = {
      businessDate: '2026-10-02',
      occurredAt: '2026-10-02T08:00:00.000Z',
      kind: 'SELF',
      flags: [],
      hasSelfie: false,
      afterSubmission: false,
      accuracyM: '20.00',
    };
    rememberToday(s, 'd1', today);
    expect(recallToday(s, 'd1', '2026-10-02')).toEqual(today);
    expect(recallToday(s, 'd1', '2026-10-03')).toBeNull();
    expect(recallToday(s, 'd2', '2026-10-02')).toBeNull();
    expect(recallToday(null, 'd1', '2026-10-02')).toBeNull();
    // The stored record carries no coordinates.
    expect([...m.values()].join()).not.toMatch(/1\.000000/);
  });
});
