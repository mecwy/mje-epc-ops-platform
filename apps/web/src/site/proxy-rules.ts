import type {
  FixInput,
  PmProxyCheckInCommand,
  ProxySource,
  RosterDto,
} from '@mje/contracts';
import { shift } from '../report/format.js';

/** The wall-clock parts of an instant in a time zone. */
function wall(t: number, timeZone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(t))
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(
    +p.year!,
    +p.month! - 1,
    +p.day!,
    +p.hour!,
    +p.minute!,
    +p.second!,
  );
}
/**
 * The instant of a site-local date and time (HH:MM) in the site's time zone, with the tz
 * database (DST-safe). A time that does not exist that day (spring gap) is null, never moved.
 */
export function siteInstant(
  date: string,
  time: string,
  timeZone: string,
): string | null {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m || !d || +m[1]! > 23 || +m[2]! > 59) return null;
  const target = Date.UTC(+d[1]!, +d[2]! - 1, +d[3]!, +m[1]!, +m[2]!);
  let t = target - (wall(target, timeZone) - target);
  t = target - (wall(t, timeZone) - t);
  return wall(t, timeZone) === target ? new Date(t).toISOString() : null;
}

/** The site days a PM may record for: today back to today − pmProxyDays (C24). */
export function proxyDays(today: string, pmProxyDays: number): string[] {
  return Array.from({ length: pmProxyDays + 1 }, (_, i) => shift(today, -i));
}

/**
 * The people a PM proxy may name for a site day: anyone with a MEMBER interval overlapping
 * that day in the site timezone, including people who have since left (design §1).
 */
export function membersOfDay(
  roster: RosterDto,
  date: string,
  timeZone: string,
): { personId: string; displayName: string }[] {
  const start = siteInstant(date, '00:00', timeZone);
  const end = siteInstant(shift(date, 1), '00:00', timeZone);
  if (!start || !end) return [];
  const seen = new Map<string, string>();
  for (const a of roster.assignments)
    if (
      a.role === 'MEMBER' &&
      a.validFrom < end &&
      (a.validUntil === null || a.validUntil > start)
    )
      seen.set(a.personId, a.displayName);
  return [...seen]
    .map(([personId, displayName]) => ({ personId, displayName }))
    .sort((x, y) => x.displayName.localeCompare(y.displayName));
}

export interface ProxyForm {
  personId: string;
  businessDate: string;
  /** Site-local HH:MM, or '' for no time (DAY precision; no time is invented). */
  time: string;
  source: ProxySource;
  reason: string;
  /** The PM's own current fix, if attached (stored only as the actor's location). */
  actorFix: FixInput | null;
}
export type ProxyProblem = 'person' | 'date' | 'time' | 'future' | 'reason';
export type ProxyCheck =
  | { ok: true; command: Omit<PmProxyCheckInCommand, 'clientMutationId'> }
  | { ok: false; problem: ProxyProblem };
/**
 * A PM proxy check-in (design §3 "PM proxy", C23): the date within the project's lookback,
 * an optional exact time (none = DAY precision), and a reason whenever the date is not the
 * site's today or no location of the PM is attached. The server stays the authority.
 */
export function checkProxy(
  f: ProxyForm,
  o: {
    projectId: string;
    today: string;
    pmProxyDays: number;
    timeZone: string;
    now: number;
  },
): ProxyCheck {
  if (!f.personId) return { ok: false, problem: 'person' };
  if (!proxyDays(o.today, o.pmProxyDays).includes(f.businessDate))
    return { ok: false, problem: 'date' };
  let occurredAt: string | null = null;
  if (f.time.trim()) {
    occurredAt = siteInstant(f.businessDate, f.time.trim(), o.timeZone);
    if (!occurredAt) return { ok: false, problem: 'time' };
    if (Date.parse(occurredAt) > o.now) return { ok: false, problem: 'future' };
  }
  const reason = f.reason.trim();
  if (!reason && (f.businessDate !== o.today || !f.actorFix))
    return { ok: false, problem: 'reason' };
  return {
    ok: true,
    command: {
      projectId: o.projectId,
      personId: f.personId,
      businessDate: f.businessDate,
      occurredAt,
      source: f.source,
      reason,
      actorFix: f.actorFix,
    },
  };
}
