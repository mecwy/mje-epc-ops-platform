/** A derived declaration window, never a labor, attendance or verification ledger. */
import { ROLE_KEYS } from './report.js';
import { date, id, oneOf, str, version } from './parse.js';
import { reportObject } from './report-source.js';
import { InvalidReportInput, isRealTimestamp } from './report.js';

export type PersonnelCategory = (typeof ROLE_KEYS)[number];
export const PERSONNEL_CELL_STATES = [
  'value',
  'blank',
  'unknown',
  'na',
  'invalid',
  'missing',
] as const;
export type PersonnelCellState = (typeof PERSONNEL_CELL_STATES)[number];
export const PERSONNEL_TOTAL_STATES = [
  'complete',
  'partial',
  'unknown',
  'na',
  'missing',
] as const;
export type PersonnelTotalState = (typeof PERSONNEL_TOTAL_STATES)[number];

export interface PersonnelCountCellDto {
  /** Original declaration. null is an absent field, not a blank or an explicit zero. */
  raw: string | null;
  state: PersonnelCellState;
  count: string | null;
}
export interface PersonnelDayContributionDto {
  businessDate: string;
  reportRevisionId: string | null;
  n: number | null;
  categories: Record<PersonnelCategory, PersonnelCountCellDto>;
}
export interface PersonnelCategorySubtotalDto {
  knownSubtotal: string | null;
  state: PersonnelTotalState;
  valueDays: number;
  blankDays: number;
  unknownDays: number;
  notApplicableDays: number;
  invalidDays: number;
  missingFieldDays: number;
  unreportedDays: number;
}
export interface PeopleWindowSummaryDto {
  schemaVersion: 1;
  projectId: string;
  windowFrom: string;
  windowTo: string;
  basis: 'declared_category_day_sum';
  policyVersion: 'personnel-category-seven-slots-v1';
  selectedAtUTC: string;
  dayContributions: PersonnelDayContributionDto[];
  categoryKnownSubtotals: Record<
    PersonnelCategory,
    PersonnelCategorySubtotalDto
  >;
  reportedDays: number;
  slotDays: 7;
  /** Completeness of category declarations; there is deliberately no cross-category total. */
  totalState: PersonnelTotalState;
}

/** Trusted reader inputs: submitted revisions plus any explicitly excluded drafts. */
export interface PersonnelRevisionInput {
  projectId: string;
  businessDate: string;
  reportRevisionId: string;
  n: number;
  submitted: boolean;
  categories: Readonly<Record<string, string>>;
}

const count = (v: unknown, field: string): string => {
  const s = str(v, field, 16);
  if (!/^(0|[1-9]\d{0,15})$/.test(s)) throw new InvalidReportInput(field);
  return s;
};
const nullable = <T>(
  v: unknown,
  field: string,
  parse: (v: unknown, field: string) => T,
): T | null => (v === null ? null : parse(v, field));
const slots = (v: unknown, field: string): number => {
  const n = version(v, field);
  if (n > 7) throw new InvalidReportInput(field);
  return n;
};
function cell(v: unknown, field: string): PersonnelCountCellDto {
  const o = reportObject(v, ['raw', 'state', 'count'], field);
  const raw = nullable(o['raw'], `${field}.raw`, (v, f) => str(v, f, 32));
  const state = oneOf(o['state'], PERSONNEL_CELL_STATES, `${field}.state`);
  const value = nullable(o['count'], `${field}.count`, count);
  if (
    (state === 'value') !== (value !== null) ||
    (state === 'missing') !== (raw === null)
  )
    throw new InvalidReportInput(field);
  return { raw, state, count: value };
}
const categoryRecord = <T>(
  v: unknown,
  field: string,
  parse: (v: unknown, field: string) => T,
): Record<PersonnelCategory, T> => {
  const o = reportObject(v, ROLE_KEYS, field);
  return Object.fromEntries(
    ROLE_KEYS.map((key) => [key, parse(o[key], `${field}.${key}`)]),
  ) as Record<PersonnelCategory, T>;
};
function subtotal(v: unknown, field: string): PersonnelCategorySubtotalDto {
  const coverageKeys = [
    'valueDays',
    'blankDays',
    'unknownDays',
    'notApplicableDays',
    'invalidDays',
    'missingFieldDays',
    'unreportedDays',
  ] as const;
  const o = reportObject(v, ['knownSubtotal', 'state', ...coverageKeys], field);
  const coverage = Object.fromEntries(
    coverageKeys.map((key) => [key, slots(o[key], `${field}.${key}`)]),
  ) as Pick<PersonnelCategorySubtotalDto, (typeof coverageKeys)[number]>;
  if (Object.values(coverage).reduce((a, b) => a + b, 0) !== 7)
    throw new InvalidReportInput(field);
  const knownSubtotal = nullable(
    o['knownSubtotal'],
    `${field}.knownSubtotal`,
    count,
  );
  const state = oneOf(o['state'], PERSONNEL_TOTAL_STATES, `${field}.state`);
  if (
    coverage.valueDays > 0 !== (knownSubtotal !== null) ||
    (state === 'complete' || state === 'partial') !== (knownSubtotal !== null)
  )
    throw new InvalidReportInput(field);
  return { knownSubtotal, state, ...coverage };
}

/** Safe boundary projection; arithmetic remains in the domain rule, not this parser. */
export function parsePeopleWindowSummary(v: unknown): PeopleWindowSummaryDto {
  const o = reportObject(
    v,
    [
      'schemaVersion',
      'projectId',
      'windowFrom',
      'windowTo',
      'basis',
      'policyVersion',
      'selectedAtUTC',
      'dayContributions',
      'categoryKnownSubtotals',
      'reportedDays',
      'slotDays',
      'totalState',
    ],
    'personnelSummary',
  );
  if (
    o['schemaVersion'] !== 1 ||
    o['slotDays'] !== 7 ||
    o['basis'] !== 'declared_category_day_sum' ||
    o['policyVersion'] !== 'personnel-category-seven-slots-v1'
  )
    throw new InvalidReportInput('personnelSummary.policy');
  const windowFrom = date(o['windowFrom'], 'personnelSummary.windowFrom');
  const windowTo = date(o['windowTo'], 'personnelSummary.windowTo');
  const selectedAtUTC = str(
    o['selectedAtUTC'],
    'personnelSummary.selectedAtUTC',
    24,
  );
  if (!isRealTimestamp(selectedAtUTC) || !selectedAtUTC.endsWith('Z'))
    throw new InvalidReportInput('personnelSummary.selectedAtUTC');
  const rows = o['dayContributions'];
  if (!Array.isArray(rows) || rows.length !== 7)
    throw new InvalidReportInput('personnelSummary.dayContributions');
  const dayContributions = rows.map((v, i): PersonnelDayContributionDto => {
    const field = `personnelSummary.dayContributions[${i}]`;
    const row = reportObject(
      v,
      ['businessDate', 'reportRevisionId', 'n', 'categories'],
      field,
    );
    const businessDate = date(row['businessDate'], `${field}.businessDate`);
    const expected = new Date(`${windowFrom}T12:00:00Z`);
    expected.setUTCDate(expected.getUTCDate() + i);
    if (businessDate !== expected.toISOString().slice(0, 10))
      throw new InvalidReportInput(`${field}.businessDate`);
    const reportRevisionId = nullable(
      row['reportRevisionId'],
      `${field}.reportRevisionId`,
      id,
    );
    const n = nullable(row['n'], `${field}.n`, version);
    const categories = categoryRecord(
      row['categories'],
      `${field}.categories`,
      cell,
    );
    if (
      (reportRevisionId === null) !== (n === null) ||
      (n !== null && n < 1) ||
      (n === null &&
        ROLE_KEYS.some((key) => categories[key].state !== 'missing'))
    )
      throw new InvalidReportInput(field);
    return { businessDate, reportRevisionId, n, categories };
  });
  if (dayContributions[6]?.businessDate !== windowTo)
    throw new InvalidReportInput('personnelSummary.windowTo');
  const reportedDays = slots(
    o['reportedDays'],
    'personnelSummary.reportedDays',
  );
  if (
    dayContributions.filter((row) => row.reportRevisionId !== null).length !==
    reportedDays
  )
    throw new InvalidReportInput('personnelSummary.reportedDays');
  const categoryKnownSubtotals = categoryRecord(
    o['categoryKnownSubtotals'],
    'personnelSummary.categoryKnownSubtotals',
    subtotal,
  );
  if (
    ROLE_KEYS.some(
      (key) => categoryKnownSubtotals[key].unreportedDays !== 7 - reportedDays,
    )
  )
    throw new InvalidReportInput('personnelSummary.coverage');
  return {
    schemaVersion: 1,
    projectId: id(o['projectId'], 'personnelSummary.projectId'),
    windowFrom,
    windowTo,
    basis: 'declared_category_day_sum',
    policyVersion: 'personnel-category-seven-slots-v1',
    selectedAtUTC,
    dayContributions,
    categoryKnownSubtotals,
    reportedDays,
    slotDays: 7,
    totalState: oneOf(
      o['totalState'],
      PERSONNEL_TOTAL_STATES,
      'personnelSummary.totalState',
    ),
  };
}
