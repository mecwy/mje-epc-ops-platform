/**
 * Pure Site Daily Close rules. No I/O, no HTTP, no floats.
 * Inputs are plain values; the store and the browser both call these so that
 * server-side enforcement and client-side previews cannot drift.
 */
import { isRealTimestamp, type SourceReport } from '@mje/contracts';

export const TOKENS = ['unknown', 'na'] as const;
export type Token = (typeof TOKENS)[number];
/** A reported number: decimal string, an explicit token, or '' (not filled). */
export type Reported = string;

export const ESCALATION_CATEGORIES = [
  'progressLag',
  'milestoneRisk',
  'safety',
  'quality',
  'externalStop',
  'resourceGap',
  'costChange',
  'subDispute',
] as const;
export type EscalationCategory = (typeof ESCALATION_CATEGORIES)[number];

export const NO_WORK_REASONS = ['rest', 'weather', 'permit', 'other'] as const;
export type NoWorkReason = (typeof NO_WORK_REASONS)[number];

export const ROLE_KEYS = [
  'manager',
  'safetyOfficer',
  'supervisor',
  'subManager',
  'installer',
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];
export const ROLE_GROUP: Record<RoleKey, 'gc' | 'sub' | 'worker'> = {
  manager: 'gc',
  safetyOfficer: 'gc',
  supervisor: 'gc',
  subManager: 'sub',
  installer: 'worker',
};

// ---------- decimal (scaled BigInt, 6 places; quantities are Decimal(20,6)) ----------
const SCALE = 1_000_000n;
const DECIMAL = /^\d{1,14}(\.\d{1,6})?$/;
/** Largest scaled value that still fits Decimal(20,6) and the contract parser (14 integer digits). */
export const MAX_SCALED = 100_000_000_000_000n * SCALE - 1n;
export const inRange = (n: bigint): boolean => n >= 0n && n <= MAX_SCALED;
export function dec(raw: unknown): bigint | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(',', '.');
  if (!DECIMAL.test(s)) return null;
  const [a, b = ''] = s.split('.');
  return BigInt(a!) * SCALE + BigInt(b.padEnd(6, '0'));
}
export function decText(n: bigint): string {
  const neg = n < 0n;
  if (neg) n = -n;
  const whole = n / SCALE;
  const frac = String(n % SCALE)
    .padStart(6, '0')
    .replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}
/** Percentage with one decimal, rounded half up; null when not computable. */
export function pct(num: bigint | null, den: bigint | null): string | null {
  if (num === null || den === null || den === 0n) return null;
  const permille = (num * 10_000n) / den;
  const r = (permille + 5n) / 10n;
  return `${r / 10n}.${r % 10n}`;
}
export const isToken = (v: unknown): v is Token =>
  typeof v === 'string' && (TOKENS as readonly string[]).includes(v);
/** '' | token | valid decimal. Anything else is a format error. */
export const isReported = (v: unknown): v is Reported =>
  v === '' || isToken(v) || dec(v) !== null;

// ---------- dates ----------
export const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000,
  );
}

// ---------- facts ----------
export interface NoWork {
  reason: NoWorkReason;
  note: string;
}
export interface MilestoneFact {
  actual: string;
  note: string;
}
export interface DayFacts {
  sourceReport?: SourceReport;
  weather: string;
  temperature: string;
  qty: Record<string, Reported>;
  cumulative: Record<string, Reported>;
  narrative: { construction: string; quality: string; safety: string };
  people: Record<string, Reported>;
  presence: Record<string, string>;
  machinery: Record<string, Reported>;
  materials: Record<string, Reported>;
  milestones: Record<string, MilestoneFact>;
  noWork: NoWork | null;
  updated: Record<string, string>;
}
export function blankFacts(): DayFacts {
  return {
    weather: '',
    temperature: '',
    qty: {},
    cumulative: {},
    narrative: { construction: '', quality: '', safety: '' },
    people: {},
    presence: {},
    machinery: {},
    materials: {},
    milestones: {},
    noWork: null,
    updated: {},
  };
}
export function hasFacts(f: DayFacts): boolean {
  return Boolean(
    (f.sourceReport &&
      ((f.sourceReport.schemaVersion !== 1 &&
        f.sourceReport.reportedNextPlan &&
        Object.keys(f.sourceReport.reportedNextPlan.quantities).length) ||
        ('milestones' in f.sourceReport &&
          f.sourceReport.milestones &&
          Object.keys(f.sourceReport.milestones).length) ||
        ((f.sourceReport.schemaVersion === 4 ||
          f.sourceReport.schemaVersion === 5) &&
          (f.sourceReport.reportedRecorder ||
            Object.keys(f.sourceReport.machinery ?? {}).length ||
            Object.keys(f.sourceReport.personnelRemarks ?? {}).length)) ||
        (f.sourceReport.schemaVersion === 5 &&
          (f.sourceReport.reportedDuration ||
            Object.keys(f.sourceReport.workAreas ?? {}).length)) ||
        f.sourceReport.peopleTotal ||
        Object.keys(f.sourceReport.workPercent).length ||
        Object.values(f.sourceReport.materials).some(
          (row) => Object.keys(row).length,
        ))) ||
    f.noWork ||
    f.weather ||
    f.temperature ||
    Object.values(f.qty).some(Boolean) ||
    Object.values(f.cumulative).some(Boolean) ||
    Object.values(f.narrative).some((x) => x.trim()) ||
    Object.values(f.people).some(Boolean) ||
    Object.values(f.presence).some(Boolean) ||
    Object.values(f.machinery).some(Boolean) ||
    Object.values(f.materials).some(Boolean) ||
    Object.values(f.milestones).some((m) => m.actual || m.note),
  );
}

// ---------- plans ----------
export interface PlanRow {
  item: string;
  target: Reported;
}
export interface PlanVersion {
  n: number;
  rows: PlanRow[];
  at: string;
}
export interface PlanState {
  versions: PlanVersion[];
  draft: PlanRow[] | null;
}
export type PlanStatus =
  | { status: 'confirmed'; n: number }
  | { status: 'draft'; n: number | null }
  | { status: 'none'; n: null };

/** The baseline for a day is the latest confirmed plan version targeting it. A draft never is. */
export function baseline(plan: PlanState | undefined): PlanVersion | null {
  return plan?.versions.at(-1) ?? null;
}
export function planStatus(plan: PlanState | undefined): PlanStatus {
  const n = plan?.versions.length ? plan.versions.at(-1)!.n : null;
  if (plan?.draft) return { status: 'draft', n };
  if (n !== null) return { status: 'confirmed', n };
  return { status: 'none', n: null };
}
/** Rows shown for a target day: its draft, else its latest version, else yesterday's baseline as a suggestion. */
export function planRows(
  plan: PlanState | undefined,
  previousDayPlan: PlanState | undefined,
): PlanRow[] {
  if (plan?.draft) return plan.draft;
  if (plan?.versions.length) return plan.versions.at(-1)!.rows;
  const b = baseline(previousDayPlan);
  return b ? b.rows.map((r) => ({ ...r })) : [];
}
export type ConfirmOutcome =
  | { ok: true; version: PlanVersion }
  | { ok: false; reason: 'noChange' | 'emptyPlan' | 'numberInvalid' };
/** Confirming without a new draft is a no-op: no duplicate versions. */
export function confirmPlan(
  plan: PlanState | undefined,
  previousDayPlan: PlanState | undefined,
  at: string,
): ConfirmOutcome {
  if (plan?.versions.length && !plan.draft)
    return { ok: false, reason: 'noChange' };
  const rows = planRows(plan, previousDayPlan).filter(
    (r) => String(r.target ?? '').trim() !== '',
  );
  if (!rows.length) return { ok: false, reason: 'emptyPlan' };
  if (rows.some((r) => dec(r.target) === null))
    return { ok: false, reason: 'numberInvalid' };
  return {
    ok: true,
    // Copies: later draft edits must never reach a confirmed version.
    version: {
      n: (plan?.versions.length ?? 0) + 1,
      rows: rows.map((r) => ({ item: r.item, target: r.target })),
      at,
    },
  };
}
export function plannedItems(b: PlanVersion | null): Set<string> {
  return new Set(
    (b?.rows ?? [])
      .filter((r) => (dec(r.target) ?? 0n) > 0n)
      .map((r) => r.item),
  );
}

// ---------- quantities ----------
export interface CumulativeSuggestion {
  base: string;
  qty: string;
  sum: string;
}
/** Suggested cumulative = last submitted cumulative + today. Never written without adoption. */
export function suggestCumulative(
  lastSubmittedCumulative: Reported | undefined,
  todayQty: Reported | undefined,
): CumulativeSuggestion | null {
  const base = dec(lastSubmittedCumulative);
  const q = dec(todayQty);
  // A sum outside Decimal(20,6) is not adoptable; the caller shows no suggestion.
  return base !== null && q !== null && inRange(base + q)
    ? { base: decText(base), qty: decText(q), sum: decText(base + q) }
    : null;
}
// ---------- foreman quantity reports (A6 design §4) ----------
/** One crew's report for a day: its latest revision `n` (a higher n supersedes a lower one). */
export interface ForemanReport {
  crew: string;
  n: number;
  rows: { item: string; qty: Reported }[];
}
/**
 * What one crew said about one item: no report at all, the item absent or blank, `unknown`,
 * `na`, an explicit zero or a positive value.
 */
export type CrewItemStatus =
  'MISSING_REPORT' | 'OMITTED' | 'UNKNOWN' | 'NA' | 'ZERO' | 'VALUE';
/**
 * COMPLETE: every expected crew gave a number or `na`, at least one a number, and the sum fits
 * Decimal(20,6). ALL_NA: every expected crew said `na` (not a number). PARTIAL: some crew is
 * missing, omitted the item or said `unknown` (or the expected crew set is empty). OVERFLOW:
 * the sum leaves Decimal(20,6). Only COMPLETE may be adopted.
 */
export type ForemanTotalStatus = 'COMPLETE' | 'ALL_NA' | 'PARTIAL' | 'OVERFLOW';
export interface ForemanItemTotal {
  status: ForemanTotalStatus;
  /** COMPLETE only: the exact sum. */
  value: string | null;
  /** PARTIAL only: the sum of the numbers that were given, shown as "≥"; null when none fit. */
  atLeast: string | null;
  /** Per crew: expected crews always; a report outside the expected set too (`expected` false). */
  crews: Record<
    string,
    { status: CrewItemStatus; qty: Reported | null; expected: boolean }
  >;
}
function crewItemStatus(qty: Reported | undefined): CrewItemStatus {
  if (qty === undefined || qty === '') return 'OMITTED';
  if (qty === 'na') return 'NA';
  const n = dec(qty);
  // 'unknown', and anything that is not a number, is never read as one.
  if (n === null) return 'UNKNOWN';
  return n === 0n ? 'ZERO' : 'VALUE';
}
/**
 * Per-item completeness of the foreman reports against the expected crew set (every crew with a
 * MEMBER or FOREMAN interval overlapping the day, with or without a foreman). A crew without a
 * report is MISSING_REPORT, never zero; blanks and `unknown` are never read as numbers; the
 * total is a number only when it is COMPLETE. A report from a crew outside the expected set is
 * never dropped silently: a number or `unknown` from it makes the item PARTIAL. Items are the
 * given ones (in order) followed by any other item a report names.
 */
export function foremanTotals(
  expectedCrews: string[],
  reports: ForemanReport[],
  items: string[],
): Record<string, ForemanItemTotal> {
  const latest = new Map<string, Map<string, Reported>>();
  const latestN = new Map<string, number>();
  for (const r of reports)
    if ((latestN.get(r.crew) ?? -1) < r.n) {
      latestN.set(r.crew, r.n);
      latest.set(r.crew, new Map(r.rows.map((x) => [x.item, x.qty])));
    }
  const expected = [...new Set(expectedCrews)];
  const outside = [...latest.keys()].filter((c) => !expected.includes(c));
  const keys = [...new Set(items)];
  const extra = new Set<string>();
  for (const rows of latest.values())
    for (const item of rows.keys()) if (!keys.includes(item)) extra.add(item);
  const out: Record<string, ForemanItemTotal> = {};
  for (const item of [...keys, ...[...extra].sort()]) {
    const crews: ForemanItemTotal['crews'] = {};
    // An empty expected set is never complete (and never "all n/a").
    let partial = expected.length === 0;
    let allNa = expected.length > 0;
    let numbers = 0;
    let sum = 0n;
    for (const crew of expected) {
      const rows = latest.get(crew);
      const qty = rows ? (rows.get(item) ?? '') : null;
      const status = rows ? crewItemStatus(rows.get(item)) : 'MISSING_REPORT';
      crews[crew] = { status, qty, expected: true };
      if (status !== 'NA') allNa = false;
      if (status === 'ZERO' || status === 'VALUE') {
        sum += dec(qty)!;
        numbers++;
      } else if (status !== 'NA') partial = true;
    }
    for (const crew of outside) {
      const qty = latest.get(crew)!.get(item) ?? '';
      const status = crewItemStatus(qty);
      crews[crew] = { status, qty, expected: false };
      if (status === 'UNKNOWN' || status === 'ZERO' || status === 'VALUE')
        partial = true;
    }
    out[item] = partial
      ? {
          status: 'PARTIAL',
          value: null,
          atLeast: numbers && inRange(sum) ? decText(sum) : null,
          crews,
        }
      : allNa
        ? { status: 'ALL_NA', value: null, atLeast: null, crews }
        : inRange(sum)
          ? { status: 'COMPLETE', value: decText(sum), atLeast: null, crews }
          : { status: 'OVERFLOW', value: null, atLeast: null, crews };
  }
  return out;
}
/**
 * What an adoption was decided on: the roster version, the expected crews and each expected
 * crew's latest revision number (null = no report). Order does not matter.
 */
export interface ForemanBasis {
  rosterVersion: number;
  expectedCrews: string[];
  revisions: { crewId: string; n: number | null }[];
}
/** Whether a client's basis is exactly the current one (any difference is a change). */
export function sameForemanBasis(a: ForemanBasis, b: ForemanBasis): boolean {
  const crews = (x: ForemanBasis) => [...new Set(x.expectedCrews)].sort();
  const revs = (x: ForemanBasis) =>
    [...x.revisions]
      .map((r) => `${r.crewId}:${r.n ?? '-'}`)
      .sort()
      .join(',');
  return (
    a.rosterVersion === b.rosterVersion &&
    a.expectedCrews.length === crews(a).length &&
    b.expectedCrews.length === crews(b).length &&
    crews(a).join(',') === crews(b).join(',') &&
    a.revisions.length === b.revisions.length &&
    revs(a) === revs(b)
  );
}
/**
 * A foreman writes only for the site's today or yesterday (§1 historical writes), judged from
 * the site's calendar date at the decision time, never a client date; older days are PM-only
 * and a future day is not a report.
 */
export function foremanDateAllowed(
  businessDate: string,
  siteToday: string,
): 'ok' | 'future' | 'tooOld' {
  if (businessDate > siteToday) return 'future';
  return businessDate >= shiftDate(siteToday, -1) ? 'ok' : 'tooOld';
}

// ---------- coverage (what is still missing; never blocks submission) ----------
export type MissingKey =
  | 'weather'
  | 'qty'
  | 'cumulative'
  | 'photo'
  | 'construction'
  | 'quality'
  | 'safety'
  | 'people'
  | 'machinery'
  | 'materials';
export interface Missing {
  key: MissingKey;
  item?: string;
  n?: number;
}
export interface Invalid {
  key: 'qty' | 'cumulative' | 'people' | 'machinery' | 'materials';
  item?: string;
}
export interface CoverageInput {
  facts: DayFacts;
  itemIds: string[];
  machineryIds: string[];
  materialIds: string[];
  baseline: PlanVersion | null;
  /** item ids that have at least one linked photo for the day */
  photographedItems: Set<string>;
}
export interface Coverage {
  missing: Missing[];
  invalid: Invalid[];
}
export function coverage(input: CoverageInput): Coverage {
  const f = input.facts;
  const missing: Missing[] = [];
  const invalid: Invalid[] = [];
  const planned = plannedItems(input.baseline);
  for (const id of input.itemIds) {
    const v = f.qty[id];
    if (!isReported(v ?? '')) invalid.push({ key: 'qty', item: id });
    if (!isReported(f.cumulative[id] ?? ''))
      invalid.push({ key: 'cumulative', item: id });
  }
  for (const r of ROLE_KEYS)
    if (!isReported(f.people[r] ?? '')) invalid.push({ key: 'people' });
  for (const id of input.machineryIds)
    if (!isReported(f.machinery[id] ?? ''))
      invalid.push({ key: 'machinery', item: id });
  for (const id of input.materialIds)
    if (!isReported(f.materials[id] ?? ''))
      invalid.push({ key: 'materials', item: id });
  if (f.noWork) return { missing, invalid };

  if (!f.weather.trim()) missing.push({ key: 'weather' });
  for (const id of input.itemIds) {
    const v = f.qty[id] ?? '';
    if (planned.has(id) && !v) missing.push({ key: 'qty', item: id });
    else if (dec(v) !== null && !(f.cumulative[id] ?? ''))
      missing.push({ key: 'cumulative', item: id });
    if ((dec(v) ?? 0n) > 0n && !input.photographedItems.has(id))
      missing.push({ key: 'photo', item: id });
  }
  for (const k of ['construction', 'quality', 'safety'] as const)
    if (!f.narrative[k].trim()) missing.push({ key: k });
  if (ROLE_KEYS.every((r) => !f.people[r])) missing.push({ key: 'people' });
  const mach = input.machineryIds.filter((id) => !f.machinery[id]).length;
  if (mach) missing.push({ key: 'machinery', n: mach });
  const mat = input.materialIds.filter((id) => !f.materials[id]).length;
  if (mat) missing.push({ key: 'materials', n: mat });
  return { missing, invalid };
}

// ---------- carry-over between submitted days ----------
/** A carried cumulative: the last declared value and the business day it was declared. */
export interface CarriedCumulative {
  value: Reported;
  asOf: string;
}
/** A material running total. `complete` is false once any contributing day was not a number. */
export interface MaterialCumulative {
  value: string | null;
  complete: boolean;
}
/**
 * Rule 3/4: the cumulative a day hands to the next one. A declared cumulative wins. Without
 * one, the previous value stands only when nothing was declared as done today (no work, blank,
 * explicit zero or n/a); if work was declared but no cumulative, the stale base is dropped so
 * that no wrong suggestion follows.
 */
export function carryCumulative(
  businessDate: string,
  facts: DayFacts,
  previous: Record<string, CarriedCumulative>,
): Record<string, CarriedCumulative> {
  const out: Record<string, CarriedCumulative> = {};
  const keys = new Set([
    ...Object.keys(previous),
    ...Object.keys(facts.cumulative),
  ]);
  for (const key of keys) {
    const declared = facts.cumulative[key] ?? '';
    if (declared !== '') {
      out[key] = { value: declared, asOf: businessDate };
      continue;
    }
    const q = facts.qty[key] ?? '';
    const nothingDone =
      facts.noWork !== null || q === '' || q === 'na' || dec(q) === 0n;
    if (nothingDone && previous[key]) out[key] = previous[key];
  }
  return out;
}
/**
 * Material running totals. A number (zero included) is added; 'na', or a blank on a no-work
 * day, leaves the total unchanged; a blank on a work day or 'unknown' keeps the known subtotal
 * but marks it incomplete. A total outside Decimal(20,6) becomes unknown.
 */
export function carryMaterial(
  base: MaterialCumulative,
  receipt: Reported | undefined,
  noWork: boolean,
): MaterialCumulative {
  if (base.value === null) return { value: null, complete: false };
  const r = receipt ?? '';
  const q = dec(r);
  if (q !== null) {
    const sum = (dec(base.value) ?? 0n) + q;
    return inRange(sum)
      ? { value: decText(sum), complete: base.complete }
      : { value: null, complete: false };
  }
  if (r === 'na' || (r === '' && noWork)) return base;
  return { value: base.value, complete: false };
}

// ---------- people ----------
/** Sum of the numeric role counts; null when nothing numeric or the sum leaves Decimal(20,6). */
export function peopleTotal(people: Record<string, Reported>): string | null {
  const any = ROLE_KEYS.some((r) => dec(people[r]) !== null);
  if (!any) return null;
  const total = ROLE_KEYS.reduce((a, r) => a + (dec(people[r]) ?? 0n), 0n);
  return inRange(total) ? decText(total) : null;
}

// ---------- escalation reminder (a suggestion only; the PM decides) ----------
export interface LagDay {
  businessDate: string;
  baseline: PlanVersion | null;
  qty: Record<string, Reported>;
}
/**
 * Items under `thresholdPercent` of their baseline on `days` consecutive calendar days ending on
 * the latest business date in `history`, unless already escalated or dismissed. A day without an entry, a
 * baseline or a number breaks the streak: no data is not evidence of lag.
 */
export function lagSuggestions(
  history: LagDay[],
  alreadyEscalated: Set<string>,
  dismissed: Set<string>,
  days = 3,
  thresholdPercent = 80n,
): string[] {
  // "Today" is the latest entry by business date; array order carries no meaning.
  const today = history.reduce<LagDay | undefined>(
    (best, d) => (!best || d.businessDate > best.businessDate ? d : best),
    undefined,
  );
  if (!today?.baseline || days < 1) return [];
  const byDate = new Map(history.map((d) => [d.businessDate, d]));
  const window: LagDay[] = [];
  for (let i = 0; i < days; i++) {
    const d = byDate.get(shiftDate(today.businessDate, -i));
    if (!d) return [];
    window.push(d);
  }
  return today.baseline.rows
    .filter((r) => (dec(r.target) ?? 0n) > 0n)
    .map((r) => r.item)
    .filter((item) =>
      window.every((d) => {
        const t = dec(d.baseline?.rows.find((x) => x.item === item)?.target);
        const q = dec(d.qty[item]);
        return (
          t !== null && t > 0n && q !== null && q * 100n < t * thresholdPercent
        );
      }),
    )
    .filter((item) => !alreadyEscalated.has(item) && !dismissed.has(item));
}

// ---------- issues ----------
export interface IssueRules {
  controlled: boolean;
  category: EscalationCategory | '';
}
export function canEscalate(issue: IssueRules): boolean {
  return issue.category !== '';
}
/** Expert-controlled issues are never closed by the project manager. */
export function canCloseByPm(issue: IssueRules): boolean {
  return !issue.controlled;
}

// ---------- photos ----------
export interface PhotoLocation {
  lat: number;
  lon: number;
  accuracyM: number | null;
  fixAt: string | null;
}
export type PhotoSource = 'camera' | 'album';
/** A usable device fix: real coordinates, a finite non-negative accuracy and the fix time. */
export function isDeviceFix(loc: PhotoLocation | null): loc is PhotoLocation {
  return (
    loc !== null &&
    Number.isFinite(loc.lat) &&
    Math.abs(loc.lat) <= 90 &&
    Number.isFinite(loc.lon) &&
    Math.abs(loc.lon) <= 180 &&
    loc.accuracyM !== null &&
    Number.isFinite(loc.accuracyM) &&
    loc.accuracyM >= 0 &&
    typeof loc.fixAt === 'string' &&
    isRealTimestamp(loc.fixAt)
  );
}
/** In-app capture is evidence: it must carry a device fix. Album uploads may not. */
export function photoAcceptable(
  source: PhotoSource,
  loc: PhotoLocation | null,
): boolean {
  return source === 'album' || isDeviceFix(loc);
}

// ---------- check-in ----------
export interface CheckinRules {
  person: string;
  actor: string;
  actorRole: 'worker' | 'foreman' | 'manager';
  actorCrew: string | null;
  personCrew: string | null;
  alreadyToday: boolean;
  distanceM: number | null;
  radiusM?: number;
}
export type CheckinDecision =
  | { ok: true }
  | {
      ok: false;
      reason: 'already' | 'proxyNotAllowed' | 'outsideSite' | 'noLocation';
    };
export function checkinDecision(r: CheckinRules): CheckinDecision {
  if (r.alreadyToday) return { ok: false, reason: 'already' };
  if (r.actor !== r.person) {
    const ok =
      r.actorRole === 'manager' ||
      (r.actorRole === 'foreman' &&
        r.actorCrew !== null &&
        r.actorCrew === r.personCrew);
    if (!ok) return { ok: false, reason: 'proxyNotAllowed' };
  }
  // A distance that is not a finite non-negative number is no location at all.
  if (r.distanceM === null || !Number.isFinite(r.distanceM) || r.distanceM < 0)
    return { ok: false, reason: 'noLocation' };
  const radius = r.radiusM ?? 500;
  if (!Number.isFinite(radius) || radius <= 0)
    throw new RangeError('radiusM must be a positive number');
  if (r.distanceM > radius) return { ok: false, reason: 'outsideSite' };
  return { ok: true };
}
/** Haversine in metres; adequate for a 500 m site fence. NaN for coordinates off the globe. */
export function distanceM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  for (const p of [a, b])
    if (
      !Number.isFinite(p.lat) ||
      Math.abs(p.lat) > 90 ||
      !Number.isFinite(p.lon) ||
      Math.abs(p.lon) > 180
    )
      return Number.NaN;
  const R = 6_371_000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dl = rad(b.lat - a.lat);
  const dn = rad(b.lon - a.lon);
  const h =
    Math.sin(dl / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
