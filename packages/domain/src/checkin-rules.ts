/**
 * Pure check-in admission rules (A6 design §3). Every instant is judged against the request's
 * decision time (`receivedAt`, design §5). A check-in is only the claim "P was on site at T":
 * nothing here turns it into hours or headcount, and nothing is ever corrected silently.
 */
import type { CheckInFlag } from '@mje/contracts';
import { daysBetween, distanceM } from './report-rules.js';

const MINUTE = 60_000;
/** T1: a fix no older than 2 minutes at the tap, and never from after it. */
export const FIX_STALE_MS = 2 * MINUTE;
/** T3: device clock vs server receipt. */
export const SKEW_MS = 5 * MINUTE;
/** T4 (U6): normal up to 15 minutes, LATE up to 24 hours. */
export const LATE_AFTER_MS = 15 * MINUTE;
export const TOO_LATE_MS = 24 * 60 * MINUTE;
/** U2: self check-in is refused with accuracy worse than 100 m. */
export const MAX_ACCURACY_M = 100;
/** U3 default: how many days back a PM proxy may go. */
export const PM_PROXY_DAYS_DEFAULT = 7;
/** Staged selfie lifetime, and the cleanup grace after it (design §3). */
export const SELFIE_STAGED_MS = 60 * MINUTE;
export const SELFIE_GRACE_MINUTES = 5;
export const SELFIE_GRACE_MS = SELFIE_GRACE_MINUTES * MINUTE;
/**
 * U9: selfie images are kept this long after they are attached, then deleted. The one source for
 * the sweep's SQL, the scheduled job's parameters and the storage lifecycle backstop (which must
 * be longer: design C25, for a blob an interrupted upload left without a row).
 */
export const SELFIE_RETENTION_DAYS = 30;
export const SELFIE_RETENTION_MS = SELFIE_RETENTION_DAYS * 24 * 60 * MINUTE;
export const SELFIE_BLOB_BACKSTOP_DAYS = 45;

export type TimeRefusal =
  | 'FIX_TIME_INVALID'
  | 'TIME_ORDER_INVALID'
  | 'DEVICE_CLOCK_SKEW'
  | 'TOO_LATE'
  | 'BUSINESS_DAY_MISMATCH';
export type FenceRefusal =
  'LOCATION_TOO_COARSE' | 'GEOFENCE_OUTSIDE' | 'SITE_NOT_CONFIGURED';

/** The calendar date of an instant in a time zone (tz database, DST-safe), as YYYY-MM-DD. */
export function localDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export interface DeviceTimes {
  occurredAt: Date;
  fixAt: Date;
  deviceSentAt: Date;
  /** The decision time (design §5). */
  receivedAt: Date;
  businessDate: string;
  timeZone: string;
  /**
   * Foreman proxy (§1 historical writes): the business day must also be the site's today or
   * yesterday at receipt. Separate from the 24 h limit: across the spring DST change 23 h 45 min
   * can span two calendar days.
   */
  todayOrYesterday?: boolean;
}
/**
 * Time admission T1–T5 for self and foreman-proxy check-ins, first attempt only (a replay never
 * re-runs it). Returns the LATE flag when accepted, or the first rule that refuses.
 */
export function admitDeviceTimes(
  t: DeviceTimes,
): { ok: true; flags: CheckInFlag[] } | { ok: false; code: TimeRefusal } {
  const occurred = t.occurredAt.getTime();
  const fix = t.fixAt.getTime();
  const sent = t.deviceSentAt.getTime();
  if (!(fix <= occurred && occurred <= fix + FIX_STALE_MS))
    return { ok: false, code: 'FIX_TIME_INVALID' };
  if (!(occurred <= sent)) return { ok: false, code: 'TIME_ORDER_INVALID' };
  if (!(Math.abs(t.receivedAt.getTime() - sent) <= SKEW_MS))
    return { ok: false, code: 'DEVICE_CLOCK_SKEW' };
  const age = sent - occurred;
  if (age > TOO_LATE_MS) return { ok: false, code: 'TOO_LATE' };
  if (localDate(t.occurredAt, t.timeZone) !== t.businessDate)
    return { ok: false, code: 'BUSINESS_DAY_MISMATCH' };
  if (t.todayOrYesterday) {
    const back = daysBetween(
      t.businessDate,
      localDate(t.receivedAt, t.timeZone),
    );
    if (back > 1) return { ok: false, code: 'TOO_LATE' };
    if (back < 0) return { ok: false, code: 'TIME_ORDER_INVALID' };
  }
  return { ok: true, flags: age > LATE_AFTER_MS ? ['LATE'] : [] };
}

export interface SiteReference {
  n: number;
  lat: number;
  lon: number;
  radiusM: number;
}
export interface Fix {
  lat: number;
  lon: number;
  accuracyM: number;
}
/** Distance in 100 m buckets for a refusal event (never coordinates). */
export const distanceBucket = (d: number) => Math.floor(d / 100) * 100;

/**
 * The hard fence of self and foreman-proxy check-ins (the foreman's own fix for a proxy).
 * A missing reference is never distance 0.
 */
export function fence(
  fix: Fix,
  ref: SiteReference | null,
):
  | { ok: true; distanceM: number; flags: CheckInFlag[] }
  | { ok: false; code: FenceRefusal; distanceM: number | null } {
  if (!ref) return { ok: false, code: 'SITE_NOT_CONFIGURED', distanceM: null };
  const d = distanceM(fix, ref);
  if (!Number.isFinite(d) || !Number.isFinite(fix.accuracyM))
    return { ok: false, code: 'LOCATION_TOO_COARSE', distanceM: null };
  if (fix.accuracyM > MAX_ACCURACY_M)
    return { ok: false, code: 'LOCATION_TOO_COARSE', distanceM: d };
  if (d > ref.radiusM)
    return { ok: false, code: 'GEOFENCE_OUTSIDE', distanceM: d };
  return {
    ok: true,
    distanceM: d,
    flags: d + fix.accuracyM > ref.radiusM ? ['NEAR_EDGE'] : [],
  };
}

/**
 * A PM proxy never needs an in-fence location; its fix only produces flags (design §3). Inside
 * → none; certainly outside (`distance − accuracy > radius`) → REMOTE_PROXY; coarse or
 * ambiguous → PROXY_LOCATION_COARSE; no fix, or no reference to judge it by →
 * PROXY_LOCATION_UNAVAILABLE.
 */
export function proxyLocationFlags(
  fix: Fix | null,
  ref: SiteReference | null,
): { flags: CheckInFlag[]; distanceM: number | null } {
  if (!fix || !ref)
    return { flags: ['PROXY_LOCATION_UNAVAILABLE'], distanceM: null };
  const d = distanceM(fix, ref);
  if (!Number.isFinite(d))
    return { flags: ['PROXY_LOCATION_UNAVAILABLE'], distanceM: null };
  if (d - fix.accuracyM > ref.radiusM)
    return { flags: ['REMOTE_PROXY'], distanceM: d };
  if (fix.accuracyM > MAX_ACCURACY_M || d > ref.radiusM)
    return { flags: ['PROXY_LOCATION_COARSE'], distanceM: d };
  return { flags: [], distanceM: d };
}
