import { describe, expect, it } from 'vitest';
import {
  IDLE_MS,
  effectiveState,
  expiryReason,
  lockMode,
  nearIdle,
  type DeviceClock,
} from './field-rules.js';

const now = new Date('2026-10-05T08:00:00.000Z');
const at = (ms: number) => new Date(now.getTime() + ms);
const DAY = 86_400_000;
const confirmed = (over: Partial<DeviceClock> = {}): DeviceClock => ({
  state: 'CONFIRMED',
  pendingUntil: at(-100 * DAY),
  expiresAt: at(100 * DAY),
  memberUntil: null,
  lastSeenAt: at(-DAY),
  ...over,
});

describe('device expiry at the transaction clock', () => {
  it('a confirmed device is valid until each deadline, exclusive', () => {
    expect(expiryReason(confirmed(), now)).toBeNull();
    expect(expiryReason(confirmed({ expiresAt: now }), now)).toBe('LIFETIME');
    expect(expiryReason(confirmed({ memberUntil: now }), now)).toBe(
      'UNASSIGNED',
    );
    expect(expiryReason(confirmed({ memberUntil: at(1) }), now)).toBeNull();
    // idle: 30 days after lastSeenAt, the deadline itself is expired
    expect(expiryReason(confirmed({ lastSeenAt: at(-IDLE_MS) }), now)).toBe(
      'IDLE',
    );
    expect(
      expiryReason(confirmed({ lastSeenAt: at(-IDLE_MS + 1) }), now),
    ).toBeNull();
  });
  it('a pending device ends at pendingUntil and is never idle', () => {
    const pending = confirmed({
      state: 'PENDING',
      pendingUntil: at(1),
      lastSeenAt: at(-40 * DAY),
    });
    expect(expiryReason(pending, now)).toBeNull();
    expect(expiryReason({ ...pending, pendingUntil: now }, now)).toBe(
      'PENDING_TIMEOUT',
    );
  });
  it('a terminal device is ended, not expired, and never revives', () => {
    for (const state of ['REVOKED', 'REJECTED', 'EXPIRED'] as const) {
      expect(expiryReason(confirmed({ state }), now)).toBeNull();
      expect(effectiveState(confirmed({ state }), now)).toBe(state);
    }
    expect(effectiveState(confirmed({ expiresAt: now }), now)).toBe('EXPIRED');
  });
});

describe('bootstrap lock mode', () => {
  it('FOR SHARE only far from every deadline; lifecycle routes always FOR UPDATE', () => {
    expect(lockMode(confirmed(), now, false)).toBe('SHARE');
    expect(lockMode(confirmed(), now, true)).toBe('UPDATE');
    expect(lockMode(confirmed({ expiresAt: now }), now, false)).toBe('UPDATE');
    expect(lockMode(confirmed({ memberUntil: now }), now, false)).toBe(
      'UPDATE',
    );
    expect(
      lockMode(confirmed({ state: 'PENDING', pendingUntil: now }), now, false),
    ).toBe('UPDATE');
  });
  it('the last day before the idle deadline is FOR UPDATE (lastSeenAt + 29 days ≤ now)', () => {
    const edge = confirmed({ lastSeenAt: at(-29 * DAY) });
    expect(nearIdle(edge, now)).toBe(true);
    expect(lockMode(edge, now, false)).toBe('UPDATE');
    const before = confirmed({ lastSeenAt: at(-29 * DAY + 1) });
    expect(nearIdle(before, now)).toBe(false);
    expect(lockMode(before, now, false)).toBe('SHARE');
    // a pending device has no idle deadline
    expect(
      nearIdle(
        confirmed({
          state: 'PENDING',
          pendingUntil: at(DAY),
          lastSeenAt: at(-29 * DAY),
        }),
        now,
      ),
    ).toBe(false);
  });
});
