/** Pure projection of existing daily declarations. No I/O or second fact writer. */
import {
  InvalidReportInput,
  ROLE_KEYS,
  isRealDate,
  isRealTimestamp,
} from '@mje/contracts';
import type {
  PeopleWindowSummaryDto,
  PersonnelCategory,
  PersonnelCategorySubtotalDto,
  PersonnelCountCellDto,
  PersonnelRevisionInput,
  PersonnelTotalState,
} from '@mje/contracts';
import { dec, decText, shiftDate } from '@mje/domain/rules';

const SCALE = 1_000_000n;
const revisionIdentity =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function classify(raw: string | undefined): PersonnelCountCellDto {
  if (raw === undefined) return { raw: null, state: 'missing', count: null };
  if (typeof raw !== 'string' || raw.length > 32)
    throw new InvalidReportInput('personnelRevision.categories');
  const text = raw.trim();
  if (text === '' || text === 'unknown' || text === 'na')
    return { raw, state: text === '' ? 'blank' : text, count: null };
  const value = dec(raw);
  return value !== null && value % SCALE === 0n
    ? { raw, state: 'value', count: decText(value) }
    : { raw, state: 'invalid', count: null };
}
const record = <T>(
  make: (key: PersonnelCategory) => T,
): Record<PersonnelCategory, T> =>
  Object.fromEntries(ROLE_KEYS.map((key) => [key, make(key)])) as Record<
    PersonnelCategory,
    T
  >;

/**
 * Reader passes only authorized project revisions. Submit may include its just-assigned
 * revision and current facts as submitted=true; this function copies every contribution.
 * Selection is per business date and revision number, never receive time or today's date.
 */
export function buildPersonnelWindow(input: {
  projectId: string;
  toBusinessDate: string;
  selectedAtUTC: string;
  revisions: readonly PersonnelRevisionInput[];
}): PeopleWindowSummaryDto {
  if (
    !revisionIdentity.test(input.projectId) ||
    !isRealDate(input.toBusinessDate) ||
    !isRealTimestamp(input.selectedAtUTC) ||
    !input.selectedAtUTC.endsWith('Z')
  )
    throw new InvalidReportInput('personnelWindow.context');
  const windowFrom = shiftDate(input.toBusinessDate, -6);
  if (!isRealDate(windowFrom))
    throw new InvalidReportInput('personnelWindow.windowFrom');
  const byDate = new Map<string, PersonnelRevisionInput>();
  const byId = new Map<string, string>();
  const versions = new Map<string, string>();
  for (const row of input.revisions) {
    if (
      row.projectId !== input.projectId ||
      !isRealDate(row.businessDate) ||
      !revisionIdentity.test(row.reportRevisionId) ||
      !Number.isSafeInteger(row.n) ||
      row.n < 1 ||
      row.n > 1_000_000 ||
      typeof row.submitted !== 'boolean'
    )
      throw new InvalidReportInput('personnelRevision.identity');
    if (
      !row.submitted ||
      row.businessDate < windowFrom ||
      row.businessDate > input.toBusinessDate
    )
      continue;
    const cells = record((key) => classify(row.categories[key]));
    const fingerprint = JSON.stringify([row.businessDate, row.n, cells]);
    const existing = byId.get(row.reportRevisionId.toLowerCase());
    if (existing !== undefined && existing !== fingerprint)
      throw new InvalidReportInput('personnelRevision.immutable');
    byId.set(row.reportRevisionId.toLowerCase(), fingerprint);
    const versionKey = `${row.businessDate}/${row.n}`;
    const versionId = versions.get(versionKey);
    if (
      versionId !== undefined &&
      versionId !== row.reportRevisionId.toLowerCase()
    )
      throw new InvalidReportInput('personnelRevision.ambiguous');
    versions.set(versionKey, row.reportRevisionId.toLowerCase());
    const current = byDate.get(row.businessDate);
    if (!current || row.n > current.n) byDate.set(row.businessDate, row);
  }
  const dayContributions = Array.from({ length: 7 }, (_, i) => {
    const businessDate = shiftDate(windowFrom, i);
    const row = byDate.get(businessDate);
    return {
      businessDate,
      reportRevisionId: row?.reportRevisionId.toLowerCase() ?? null,
      n: row?.n ?? null,
      categories: record((key) => classify(row?.categories[key])),
    };
  });
  const reportedDays = byDate.size;
  const categoryKnownSubtotals = record((key): PersonnelCategorySubtotalDto => {
    let sum = 0n;
    const coverage = {
      valueDays: 0,
      blankDays: 0,
      unknownDays: 0,
      notApplicableDays: 0,
      invalidDays: 0,
      missingFieldDays: 0,
      unreportedDays: 0,
    };
    for (const day of dayContributions) {
      const cell = day.categories[key];
      if (day.reportRevisionId === null) coverage.unreportedDays++;
      else if (cell.state === 'value') {
        coverage.valueDays++;
        sum += BigInt(cell.count!);
      } else if (cell.state === 'blank') coverage.blankDays++;
      else if (cell.state === 'unknown') coverage.unknownDays++;
      else if (cell.state === 'na') coverage.notApplicableDays++;
      else if (cell.state === 'invalid') coverage.invalidDays++;
      else coverage.missingFieldDays++;
    }
    const state: PersonnelTotalState =
      coverage.valueDays > 0
        ? coverage.valueDays + coverage.notApplicableDays === 7
          ? 'complete'
          : 'partial'
        : coverage.notApplicableDays === 7
          ? 'na'
          : reportedDays === 0
            ? 'missing'
            : 'unknown';
    return {
      knownSubtotal: coverage.valueDays ? sum.toString() : null,
      state,
      ...coverage,
    };
  });
  const values = Object.values(categoryKnownSubtotals);
  const totalState: PersonnelTotalState =
    reportedDays === 0
      ? 'missing'
      : values.every((v) => v.state === 'na')
        ? 'na'
        : values.every((v) => v.state === 'complete' || v.state === 'na')
          ? 'complete'
          : values.some((v) => v.knownSubtotal !== null)
            ? 'partial'
            : 'unknown';
  return {
    schemaVersion: 1,
    projectId: input.projectId.toLowerCase(),
    windowFrom,
    windowTo: input.toBusinessDate,
    basis: 'declared_category_day_sum',
    policyVersion: 'personnel-category-seven-slots-v1',
    selectedAtUTC: input.selectedAtUTC,
    dayContributions,
    categoryKnownSubtotals,
    reportedDays,
    slotDays: 7,
    totalState,
  };
}
