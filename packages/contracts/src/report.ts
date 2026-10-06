/**
 * Site Daily Close boundary DTOs (U2.1). Values are declarations; nothing here is verified.
 * Numbers travel as decimal strings; '' = not filled; 'unknown' | 'na' are explicit states.
 */
import {
  InvalidReportInput,
  KEY,
  UUID,
  date,
  id,
  isRealDate,
  obj,
  oneOf,
  str,
  version,
} from './parse.js';

import {
  parseSourceReport,
  reportObject,
  type SourceReport,
} from './report-source.js';
export type {
  SourceCell,
  SourceReport,
  SourceReportV1,
  SourceReportV2,
  SourceReportV3,
} from './report-source.js';
export { InvalidReportInput, isRealDate };
export type Reported = string;
export const REPORT_TOKENS = ['unknown', 'na'] as const;
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

export interface DayFactsDto {
  sourceReport?: SourceReport;
  weather: string;
  temperature: string;
  qty: Record<string, Reported>;
  cumulative: Record<string, Reported>;
  narrative: { construction: string; quality: string; safety: string };
  people: Record<string, Reported>;
  presence: Record<string, 'present' | 'absent' | ''>;
  machinery: Record<string, Reported>;
  materials: Record<string, Reported>;
  milestones: Record<string, { actual: string; note: string }>;
  noWork: { reason: NoWorkReason; note: string } | null;
  /** item id -> ISO time of the last quantity change (device clock) */
  updated: Record<string, string>;
}

export interface SaveFactsCommand {
  projectId: string;
  businessDate: string;
  expectedVersion: number;
  clientMutationId: string;
  facts: DayFactsDto;
}
export interface PlanRowDto {
  item: string;
  target: Reported;
}
export interface SavePlanDraftCommand {
  projectId: string;
  targetBusinessDate: string;
  clientMutationId: string;
  rows: PlanRowDto[];
}
export interface ConfirmPlanCommand {
  projectId: string;
  targetBusinessDate: string;
  clientMutationId: string;
}
export interface SubmitReportCommand {
  projectId: string;
  businessDate: string;
  expectedVersion: number;
  clientMutationId: string;
}
export interface StartCorrectionCommand {
  projectId: string;
  businessDate: string;
  expectedVersion: number;
  clientMutationId: string;
  reason: string;
}
export interface NoWorkCommand {
  projectId: string;
  businessDate: string;
  expectedVersion: number;
  clientMutationId: string;
  reason: NoWorkReason;
  note: string;
}
export interface CancelCorrectionCommand {
  projectId: string;
  businessDate: string;
  expectedVersion: number;
  clientMutationId: string;
}
export const REPORT_ITEM_KINDS = [
  'work',
  'machinery',
  'material',
  'milestone',
] as const;
export type ReportItemKind = (typeof REPORT_ITEM_KINDS)[number];
/** Explicit C19 master capture. A legacy snapshot without these rows is unfrozen. */
export interface FrozenMilestoneDto {
  id: string;
  key: string;
  label: string;
  plannedDate: string | null;
}

/** Project master row: a work item, a machine or a material. Quantities are reported text. */
export interface ReportItemDto {
  kind: ReportItemKind;
  key: string;
  label: string;
  unit: string;
  designQty: Reported;
  openingCumulative: Reported;
  sortOrder: number;
  active: boolean;
  /** Missing preserves an existing master date on save; null explicitly clears it. */
  plannedDate?: string | null;
}
export interface SaveItemsCommand {
  projectId: string;
  clientMutationId: string;
  items: ReportItemDto[];
}

/** Numbers, timestamps and maps are report-specific; the generic parsers live in parse.ts. */
const DECIMAL = /^\d{1,14}(\.\d{1,6})?$/;
const ISO =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/** ISO-8601 instant with a real date, real time (leap seconds excluded) and an offset within ±14:00. */
export function isRealTimestamp(s: string): boolean {
  const m = ISO.exec(s);
  if (!m || !isRealDate(s.slice(0, 10))) return false;
  const [hh, mm, ss] = s.slice(11, 19).split(':').map(Number);
  if (hh! > 23 || mm! > 59 || ss! > 59) return false;
  const offset = s.slice(19).replace(/^\.\d+/, '');
  if (offset !== 'Z') {
    const [oh, om] = offset.slice(1).split(':').map(Number);
    if (oh! > 14 || om! > 59 || (oh === 14 && om! > 0)) return false;
  }
  return !Number.isNaN(Date.parse(s));
}
/** '' | 'unknown' | 'na' | decimal; commas are accepted as a decimal separator and normalized. */
export function reported(v: unknown, field: string): Reported {
  const s = str(v, field, 32).trim();
  if (s === '' || (REPORT_TOKENS as readonly string[]).includes(s)) return s;
  const n = s.replace(',', '.');
  if (!DECIMAL.test(n)) throw new InvalidReportInput(field);
  return n;
}
/** Map keys are validated before they are used in any message; a bad key is reported by position. */
function mapEntries(
  v: unknown,
  field: string,
  keyOk: (k: string) => boolean = (k) => KEY.test(k),
): [string, unknown][] {
  const entries = Object.entries(obj(v ?? {}, field));
  if (entries.length > 500) throw new InvalidReportInput(field);
  entries.forEach(([k], i) => {
    if (!keyOk(k)) throw new InvalidReportInput(`${field}[${i}]`);
  });
  return entries;
}
function reportedMap(v: unknown, field: string): Record<string, Reported> {
  const out: Record<string, Reported> = {};
  for (const [k, val] of mapEntries(v, field))
    out[k] = reported(val, `${field}.${k}`);
  return out;
}
export function parseFacts(v: unknown): DayFactsDto {
  const o = reportObject(
    v,
    [
      'weather',
      'temperature',
      'qty',
      'cumulative',
      'narrative',
      'people',
      'presence',
      'machinery',
      'materials',
      'milestones',
      'noWork',
      'updated',
      'sourceReport',
    ],
    'facts',
  );
  const narrative = reportObject(
    o['narrative'] ?? {},
    ['construction', 'quality', 'safety'],
    'facts.narrative',
  );
  // Presence is keyed by Person id (a UUID, normalized to lower case); prototype-style keys stay valid.
  const presence: DayFactsDto['presence'] = {};
  mapEntries(
    o['presence'],
    'facts.presence',
    (k) => KEY.test(k) || UUID.test(k),
  ).forEach(([k, val], i) => {
    const key = UUID.test(k) ? k.toLowerCase() : k;
    // Two spellings of one person are two declarations; never let one silently win.
    if (Object.hasOwn(presence, key))
      throw new InvalidReportInput(`facts.presence[${i}]`);
    presence[key] = oneOf(
      val,
      ['present', 'absent', ''] as const,
      `facts.presence[${i}]`,
    );
  });
  const milestones: DayFactsDto['milestones'] = {};
  for (const [k, val] of mapEntries(o['milestones'], 'facts.milestones')) {
    const m = reportObject(val, ['actual', 'note'], `facts.milestones.${k}`);
    const actual = str(m['actual'] ?? '', `facts.milestones.${k}.actual`, 10);
    if (actual && !isRealDate(actual))
      throw new InvalidReportInput(`facts.milestones.${k}.actual`);
    milestones[k] = {
      actual,
      note: str(m['note'] ?? '', `facts.milestones.${k}.note`, 500),
    };
  }
  const updated: Record<string, string> = {};
  for (const [k, val] of mapEntries(o['updated'], 'facts.updated')) {
    const s = str(val, `facts.updated.${k}`, 40);
    if (!isRealTimestamp(s)) throw new InvalidReportInput(`facts.updated.${k}`);
    updated[k] = s;
  }
  let noWork: DayFactsDto['noWork'] = null;
  if (o['noWork'] !== null && o['noWork'] !== undefined) {
    const n = reportObject(o['noWork'], ['reason', 'note'], 'facts.noWork');
    noWork = {
      reason: oneOf(n['reason'], NO_WORK_REASONS, 'facts.noWork.reason'),
      note: str(n['note'] ?? '', 'facts.noWork.note', 500),
    };
  }
  const people = reportedMap(o['people'] ?? {}, 'facts.people');
  for (const k of Object.keys(people))
    if (!(ROLE_KEYS as readonly string[]).includes(k))
      throw new InvalidReportInput(`facts.people.${k}`);
  return {
    ...(Object.hasOwn(o, 'sourceReport')
      ? { sourceReport: parseSourceReport(o['sourceReport']) }
      : {}),
    weather: str(o['weather'] ?? '', 'facts.weather', 100),
    temperature: str(o['temperature'] ?? '', 'facts.temperature', 40),
    qty: reportedMap(o['qty'], 'facts.qty'),
    cumulative: reportedMap(o['cumulative'], 'facts.cumulative'),
    narrative: {
      construction: str(
        narrative['construction'] ?? '',
        'facts.narrative.construction',
      ),
      quality: str(narrative['quality'] ?? '', 'facts.narrative.quality'),
      safety: str(narrative['safety'] ?? '', 'facts.narrative.safety'),
    },
    people,
    presence,
    machinery: reportedMap(o['machinery'], 'facts.machinery'),
    materials: reportedMap(o['materials'], 'facts.materials'),
    milestones,
    noWork,
    updated,
  };
}

export function parseSaveFactsCommand(v: unknown): SaveFactsCommand {
  const o = reportObject(
    v,
    [
      'projectId',
      'businessDate',
      'expectedVersion',
      'clientMutationId',
      'facts',
    ],
    'command',
  );
  return {
    projectId: id(o['projectId'], 'projectId'),
    businessDate: date(o['businessDate'], 'businessDate'),
    expectedVersion: version(o['expectedVersion'], 'expectedVersion'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    facts: parseFacts(o['facts']),
  };
}
export function parseSavePlanDraftCommand(v: unknown): SavePlanDraftCommand {
  const o = obj(v, 'command');
  const rows = o['rows'];
  if (!Array.isArray(rows) || rows.length > 100)
    throw new InvalidReportInput('rows');
  const seen = new Set<string>();
  return {
    projectId: id(o['projectId'], 'projectId'),
    targetBusinessDate: date(o['targetBusinessDate'], 'targetBusinessDate'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    rows: rows.map((r, i) => {
      const row = obj(r, `rows.${i}`);
      const item = str(row['item'], `rows.${i}.item`, 64);
      if (!KEY.test(item) || seen.has(item))
        throw new InvalidReportInput(`rows.${i}.item`);
      seen.add(item);
      const target = reported(row['target'] ?? '', `rows.${i}.target`);
      if ((REPORT_TOKENS as readonly string[]).includes(target))
        throw new InvalidReportInput(`rows.${i}.target`);
      return { item, target };
    }),
  };
}
export function parseConfirmPlanCommand(v: unknown): ConfirmPlanCommand {
  const o = obj(v, 'command');
  return {
    projectId: id(o['projectId'], 'projectId'),
    targetBusinessDate: date(o['targetBusinessDate'], 'targetBusinessDate'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
  };
}
export function parseSubmitReportCommand(v: unknown): SubmitReportCommand {
  const o = obj(v, 'command');
  return {
    projectId: id(o['projectId'], 'projectId'),
    businessDate: date(o['businessDate'], 'businessDate'),
    expectedVersion: version(o['expectedVersion'], 'expectedVersion'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
  };
}
export function parseStartCorrectionCommand(
  v: unknown,
): StartCorrectionCommand {
  const o = obj(v, 'command');
  const reason = str(o['reason'], 'reason', 500).trim();
  if (!reason) throw new InvalidReportInput('reason');
  return {
    projectId: id(o['projectId'], 'projectId'),
    businessDate: date(o['businessDate'], 'businessDate'),
    expectedVersion: version(o['expectedVersion'], 'expectedVersion'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    reason,
  };
}
export function parseNoWorkCommand(v: unknown): NoWorkCommand {
  const o = obj(v, 'command');
  return {
    projectId: id(o['projectId'], 'projectId'),
    businessDate: date(o['businessDate'], 'businessDate'),
    expectedVersion: version(o['expectedVersion'], 'expectedVersion'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    reason: oneOf(o['reason'], NO_WORK_REASONS, 'reason'),
    note: str(o['note'] ?? '', 'note', 500),
  };
}
export function parseCancelCorrectionCommand(
  v: unknown,
): CancelCorrectionCommand {
  const o = obj(v, 'command');
  return {
    projectId: id(o['projectId'], 'projectId'),
    businessDate: date(o['businessDate'], 'businessDate'),
    expectedVersion: version(o['expectedVersion'], 'expectedVersion'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
  };
}
export function parseSaveItemsCommand(v: unknown): SaveItemsCommand {
  const o = obj(v, 'command');
  const items = o['items'];
  if (!Array.isArray(items) || !items.length || items.length > 200)
    throw new InvalidReportInput('items');
  const seen = new Set<string>();
  return {
    projectId: id(o['projectId'], 'projectId'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    items: items.map((r, i) => {
      const row = obj(r, `items.${i}`);
      const kind = oneOf(row['kind'], REPORT_ITEM_KINDS, `items.${i}.kind`);
      const key = str(row['key'], `items.${i}.key`, 64);
      if (!KEY.test(key) || seen.has(`${kind}:${key}`))
        throw new InvalidReportInput(`items.${i}.key`);
      seen.add(`${kind}:${key}`);
      const label = str(row['label'], `items.${i}.label`, 200).trim();
      if (!label) throw new InvalidReportInput(`items.${i}.label`);
      const sortOrder = row['sortOrder'] ?? i;
      if (
        typeof sortOrder !== 'number' ||
        !Number.isInteger(sortOrder) ||
        sortOrder < 0 ||
        sortOrder > 10_000
      )
        throw new InvalidReportInput(`items.${i}.sortOrder`);
      const active = row['active'] ?? true;
      if (typeof active !== 'boolean')
        throw new InvalidReportInput(`items.${i}.active`);
      const unit = str(row['unit'] ?? '', `items.${i}.unit`, 20);
      const designQty = reported(
        row['designQty'] ?? '',
        `items.${i}.designQty`,
      );
      if (kind === 'milestone' && (unit !== '' || designQty !== ''))
        throw new InvalidReportInput(`items.${i}.milestone`);
      const planned =
        row['plannedDate'] === undefined
          ? {}
          : {
              plannedDate:
                row['plannedDate'] === null
                  ? null
                  : date(row['plannedDate'], `items.${i}.plannedDate`),
            };
      return {
        kind,
        key,
        label,
        unit,
        designQty,
        ...planned,
        openingCumulative: reported(
          row['openingCumulative'] ?? '',
          `items.${i}.openingCumulative`,
        ),
        sortOrder,
        active,
      };
    }),
  };
}
