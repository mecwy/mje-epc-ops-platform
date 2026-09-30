/**
 * Foreman quantity reports and PM adoption (A6c; design §4, §6). A foreman report is a claim
 * of the crew's quantities for a business day, never hours and never a verified fact; the PM
 * adopts a COMPLETE total explicitly and may always type any value instead. Field bodies carry
 * no projectId: the project is the device's.
 */
import { isRealTimestamp } from './report.js';
import {
  InvalidReportInput,
  date,
  id,
  itemKey,
  obj,
  str,
  version,
} from './parse.js';

export const FOREMAN_ROWS_MAX = 500;
export const FOREMAN_NOTE_MAX = 500;
/** A raw quantity as typed; the server classifies it (decimal, 'unknown', 'na', '' or NUMBER_INVALID). */
export const FOREMAN_QTY_MAX = 32;
export const CREW_ITEM_STATUSES = [
  'MISSING_REPORT',
  'OMITTED',
  'UNKNOWN',
  'NA',
  'ZERO',
  'VALUE',
] as const;
export type CrewItemStatusDto = (typeof CREW_ITEM_STATUSES)[number];
export type ForemanTotalStatusDto =
  'COMPLETE' | 'ALL_NA' | 'PARTIAL' | 'OVERFLOW';

export interface ForemanReportRowDto {
  itemKey: string;
  /** A decimal string, 'unknown', 'na' or '' (blank: stored as blank, never dropped). */
  qty: string;
}
export interface ForemanReportCommand {
  clientMutationId: string;
  businessDate: string;
  /** The foreman's own current crew; any other crew is refused (NOT_FOREMAN). */
  crewId: string;
  /** The revision this one replaces (0 = the first); otherwise REVISION_CONFLICT. */
  expectedRevision: number;
  rows: ForemanReportRowDto[];
  note: string;
  /** When the foreman composed the report on the device (stored, never judged). */
  occurredAt: string;
}
export interface ForemanReportDto {
  crewId: string;
  crewName: string;
  businessDate: string;
  /** The latest revision number; 0 = nothing reported yet. */
  n: number;
  rows: ForemanReportRowDto[];
  note: string;
  occurredAt: string | null;
  receivedAt: string | null;
  /** The project's active work items the foreman may report. */
  items: { key: string; label: string; unit: string }[];
}
export interface ForemanBasisDto {
  rosterVersion: number;
  expectedCrews: string[];
  /** Each expected crew's latest revision number; null = no report. */
  revisions: { crewId: string; n: number | null }[];
}
export interface ForemanAdoptCommand {
  projectId: string;
  businessDate: string;
  clientMutationId: string;
  item: string;
  /** The day's version (DailyClose), as for any fact write. */
  expectedVersion: number;
  basis: ForemanBasisDto;
}
export interface ForemanAdoptResultDto {
  businessDate: string;
  version: number;
  item: string;
  value: string;
  adoptionId: string;
}
/** A writer's view of the day's foreman reports (never served to a reader). */
export interface ForemanDayDto {
  rosterVersion: number;
  expectedCrews: {
    crewId: string;
    code: string;
    name: string;
    /** Whether any FOREMAN interval overlaps the day; a crew without one is still expected. */
    hasForeman: boolean;
  }[];
  revisions: {
    crewId: string;
    revisionId: string;
    n: number;
    daySeq: number;
    receivedAt: string;
  }[];
  items: Record<
    string,
    {
      status: ForemanTotalStatusDto;
      value: string | null;
      atLeast: string | null;
      crews: Record<
        string,
        { status: CrewItemStatusDto; qty: string | null; expected: boolean }
      >;
    }
  >;
  adoptions: {
    id: string;
    itemKey: string;
    value: string;
    basis: ForemanBasisDto;
    daySeq: number;
    byAccountId: string;
    at: string;
  }[];
  /** What an adoption must send back unchanged. */
  basis: ForemanBasisDto;
}

const LIST_MAX = 500;
function list(v: unknown, field: string, max = LIST_MAX): unknown[] {
  if (!Array.isArray(v) || v.length > max) throw new InvalidReportInput(field);
  return v;
}
export function parseForemanReportCommand(v: unknown): ForemanReportCommand {
  const o = obj(v, 'command');
  const rows = list(o['rows'], 'rows', FOREMAN_ROWS_MAX).map((r, i) => {
    const x = obj(r, `rows.${i}`);
    return {
      itemKey: itemKey(x['itemKey'], `rows.${i}.itemKey`),
      qty: str(x['qty'], `rows.${i}.qty`, FOREMAN_QTY_MAX),
    };
  });
  // A duplicate item key is ambiguous: refused, never merged or overwritten.
  if (new Set(rows.map((r) => r.itemKey)).size !== rows.length)
    throw new InvalidReportInput('rows');
  const occurredAt = str(o['occurredAt'], 'occurredAt', 40);
  if (!isRealTimestamp(occurredAt)) throw new InvalidReportInput('occurredAt');
  return {
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    businessDate: date(o['businessDate'], 'businessDate'),
    crewId: id(o['crewId'], 'crewId'),
    expectedRevision: version(o['expectedRevision'], 'expectedRevision'),
    rows,
    note: str(o['note'] ?? '', 'note', FOREMAN_NOTE_MAX),
    occurredAt,
  };
}
export function parseForemanBasis(v: unknown): ForemanBasisDto {
  const o = obj(v, 'basis');
  return {
    rosterVersion: version(o['rosterVersion'], 'basis.rosterVersion'),
    expectedCrews: list(o['expectedCrews'], 'basis.expectedCrews').map((c, i) =>
      id(c, `basis.expectedCrews.${i}`),
    ),
    revisions: list(o['revisions'], 'basis.revisions').map((r, i) => {
      const x = obj(r, `basis.revisions.${i}`);
      const n = x['n'];
      return {
        crewId: id(x['crewId'], `basis.revisions.${i}.crewId`),
        n: n === null ? null : version(n, `basis.revisions.${i}.n`),
      };
    }),
  };
}
export function parseForemanAdoptCommand(v: unknown): ForemanAdoptCommand {
  const o = obj(v, 'command');
  return {
    projectId: id(o['projectId'], 'projectId'),
    businessDate: date(o['businessDate'], 'businessDate'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    item: itemKey(o['item'], 'item'),
    expectedVersion: version(o['expectedVersion'], 'expectedVersion'),
    basis: parseForemanBasis(o['basis']),
  };
}
/** `GET field/report?businessDate=YYYY-MM-DD`. */
export function parseForemanReportQuery(q: { businessDate: unknown }): {
  businessDate: string;
} {
  return { businessDate: date(q.businessDate, 'businessDate') };
}
