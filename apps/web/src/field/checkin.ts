import type {
  CaptureFixDto,
  CheckInCommand,
  CheckInResultDto,
} from '@mje/contracts';
import { siteToday } from '../report/format.js';

/** The server refuses a fix coarser than this (design §3, U2); checked here before sending. */
export const MAX_ACCURACY_M = 100;
/** A fix older than this at occurredAt is refused (T1). */
export const FIX_MAX_AGE_MS = 2 * 60_000;

export type FixCheck = 'ok' | 'coarse' | 'stale';
/**
 * Whether a fix can be sent: accuracy within 100 m and read within the last 2 minutes. Only
 * accuracy and age are judged here; the site area is never known to the device (the server
 * judges the fence and remains the authority on everything).
 */
export function checkFix(fix: CaptureFixDto, now: number): FixCheck {
  if (!(Number(fix.accuracyM) <= MAX_ACCURACY_M)) return 'coarse';
  if (now - Date.parse(fix.fixAt) > FIX_MAX_AGE_MS) return 'stale';
  return 'ok';
}

/**
 * The event of a self check-in, fixed when the user checks in: occurredAt is when the fix was
 * taken or now, whichever is later (T1: fixAt ≤ occurredAt), and the business date is the
 * site's date at that instant (T5), never the phone's own date.
 */
export function checkInEvent(
  fix: CaptureFixDto,
  timeZone: string,
  now: number,
  stagedSelfieId: string | null,
): Omit<CheckInCommand, 'clientMutationId' | 'deviceSentAt'> {
  const occurred = new Date(Math.max(now, Date.parse(fix.fixAt)));
  return {
    businessDate: siteToday(timeZone, occurred),
    occurredAt: occurred.toISOString(),
    fix,
    stagedSelfieId,
  };
}
/**
 * The body of one attempt: the same key and event, with the device clock at this attempt
 * (transport, not hashed). Never earlier than occurredAt (T2).
 */
export function attempt(
  key: string,
  event: Omit<CheckInCommand, 'clientMutationId' | 'deviceSentAt'>,
  now: number,
): CheckInCommand {
  const sent = new Date(Math.max(now, Date.parse(event.occurredAt)));
  return { ...event, clientMutationId: key, deviceSentAt: sent.toISOString() };
}

/** What the phone remembers of today's check-in, to show it after a reload. */
export interface TodayCheckIn {
  businessDate: string;
  occurredAt: string | null;
  kind: string;
  flags: CheckInResultDto['flags'];
  hasSelfie: boolean;
  afterSubmission: boolean;
  accuracyM: string | null;
}
const KEY = 'mje-field-today';
export function rememberToday(
  storage: Storage | null,
  deviceId: string,
  t: TodayCheckIn,
) {
  try {
    storage?.setItem(`${KEY}:${deviceId}`, JSON.stringify(t));
  } catch {
    /* shown for this visit only */
  }
}
export function recallToday(
  storage: Storage | null,
  deviceId: string,
  businessDate: string,
): TodayCheckIn | null {
  try {
    const raw = storage?.getItem(`${KEY}:${deviceId}`);
    const t = raw ? (JSON.parse(raw) as TodayCheckIn) : null;
    return t && t.businessDate === businessDate && typeof t.kind === 'string'
      ? t
      : null;
  } catch {
    return null;
  }
}
