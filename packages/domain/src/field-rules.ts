/**
 * Pure FieldDevice lifecycle rules (A6 design §2, §5). Every deadline is compared with the
 * request's authoritative clock, `now()` = the transaction start time.
 */
import type { DeviceState } from '@mje/contracts';

const DAY = 86_400_000;
/** U5: pending 24 h, lifetime 180 days, idle 30 days. */
export const PENDING_MS = DAY;
export const LIFETIME_MS = 180 * DAY;
export const IDLE_MS = 30 * DAY;
/** A confirmed device this close to its idle deadline is authenticated `FOR UPDATE`. */
export const IDLE_MARGIN_MS = DAY;
/** The previous hash may replay its rotation for 7 days, cleared or not. */
export const PREVIOUS_HASH_MS = 7 * DAY;
export const CHALLENGE_MS = 5 * 60_000;
export const MAX_PENDING_PER_PERSON = 3;
export const MAX_FAILED_MATCHES = 5;

export type EndReason =
  | 'REJECTED'
  | 'SUPERSEDED'
  | 'REVOKED'
  | 'RELEASED'
  | 'REPLACED'
  | 'UNASSIGNED'
  | 'PENDING_TIMEOUT'
  | 'LIFETIME'
  | 'IDLE';
export type ExpiryReason = Extract<
  EndReason,
  'PENDING_TIMEOUT' | 'LIFETIME' | 'UNASSIGNED' | 'IDLE'
>;
export interface DeviceClock {
  state: DeviceState;
  pendingUntil: Date;
  expiresAt: Date;
  memberUntil: Date | null;
  lastSeenAt: Date;
}

export const isLive = (state: DeviceState) =>
  state === 'PENDING' || state === 'CONFIRMED';

/**
 * Why a live device has ended by its timestamps alone at `now`, or null while it is valid.
 * Terminal states are not "expired" here; they have already ended.
 */
export function expiryReason(d: DeviceClock, now: Date): ExpiryReason | null {
  if (!isLive(d.state)) return null;
  const t = now.getTime();
  if (d.state === 'PENDING' && d.pendingUntil.getTime() <= t)
    return 'PENDING_TIMEOUT';
  if (d.expiresAt.getTime() <= t) return 'LIFETIME';
  if (d.memberUntil && d.memberUntil.getTime() <= t) return 'UNASSIGNED';
  if (d.state === 'CONFIRMED' && d.lastSeenAt.getTime() + IDLE_MS <= t)
    return 'IDLE';
  return null;
}
/** Within the last day before the idle deadline (`lastSeenAt + 29 days ≤ at`). */
export function nearIdle(d: DeviceClock, at: Date): boolean {
  return (
    d.state === 'CONFIRMED' &&
    d.lastSeenAt.getTime() + IDLE_MS - IDLE_MARGIN_MS <= at.getTime()
  );
}
/**
 * Bootstrap step 5 lock mode, chosen from the non-locking lookup before any lock is taken (no
 * upgrades): `FOR UPDATE` for lifecycle routes and for a device that is expired or near its
 * idle deadline, so the request can persist the expiry or record its activity in its own
 * transaction; otherwise `FOR SHARE` with deferred activity.
 */
export function lockMode(
  d: DeviceClock,
  now: Date,
  lifecycle: boolean,
): 'UPDATE' | 'SHARE' {
  return lifecycle || expiryReason(d, now) !== null || nearIdle(d, now)
    ? 'UPDATE'
    : 'SHARE';
}
/** The effective state the timestamps imply (an unobserved expiry shows as EXPIRED). */
export function effectiveState(d: DeviceClock, now: Date): DeviceState {
  return expiryReason(d, now) ? 'EXPIRED' : d.state;
}
