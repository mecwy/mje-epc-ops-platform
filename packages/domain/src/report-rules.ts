/**
 * Pure Site Daily Close rules. No I/O, no HTTP, no floats.
 * Inputs are plain values; the store and the browser both call these so that
 * server-side enforcement and client-side previews cannot drift.
 */

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
    version: { n: (plan?.versions.length ?? 0) + 1, rows, at },
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
  return base !== null && q !== null
    ? { base: decText(base), qty: decText(q), sum: decText(base + q) }
    : null;
}
export interface ForemanReport {
  crew: string;
  rows: { item: string; qty: Reported }[];
  at: string;
}
/** Totals from the latest report of each crew; earlier reports of the same crew are superseded. */
export function foremanTotals(
  reports: ForemanReport[],
): Record<string, string> {
  const latest = new Map<string, ForemanReport>();
  for (const r of reports) latest.set(r.crew, r);
  const totals = new Map<string, bigint>();
  for (const rep of latest.values())
    for (const row of rep.rows) {
      const q = dec(row.qty);
      if (q !== null) totals.set(row.item, (totals.get(row.item) ?? 0n) + q);
    }
  return Object.fromEntries([...totals].map(([k, v]) => [k, decText(v)]));
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

// ---------- people ----------
export function peopleTotal(people: Record<string, Reported>): string | null {
  const any = ROLE_KEYS.some((r) => dec(people[r]) !== null);
  return any
    ? decText(ROLE_KEYS.reduce((a, r) => a + (dec(people[r]) ?? 0n), 0n))
    : null;
}

// ---------- escalation reminder (a suggestion only; the PM decides) ----------
export interface LagDay {
  baseline: PlanVersion | null;
  qty: Record<string, Reported>;
}
/** Items under 80% of their baseline on each of the last `days` days, unless already escalated or dismissed. */
export function lagSuggestions(
  history: LagDay[],
  alreadyEscalated: Set<string>,
  dismissed: Set<string>,
  days = 3,
  thresholdPercent = 80n,
): string[] {
  const today = history[0];
  if (!today?.baseline || history.length < days) return [];
  return today.baseline.rows
    .filter((r) => (dec(r.target) ?? 0n) > 0n)
    .map((r) => r.item)
    .filter((item) =>
      history.slice(0, days).every((d) => {
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
/** In-app capture is evidence: it must carry a device fix. Album uploads may not. */
export function photoAcceptable(
  source: PhotoSource,
  loc: PhotoLocation | null,
): boolean {
  return source === 'album' || loc !== null;
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
  if (r.distanceM === null) return { ok: false, reason: 'noLocation' };
  if (r.distanceM > (r.radiusM ?? 500))
    return { ok: false, reason: 'outsideSite' };
  return { ok: true };
}
/** Haversine in metres; adequate for a 500 m site fence. */
export function distanceM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6_371_000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dl = rad(b.lat - a.lat);
  const dn = rad(b.lon - a.lon);
  const h =
    Math.sin(dl / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
