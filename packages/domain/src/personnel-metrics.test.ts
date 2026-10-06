import { describe, expect, it } from 'vitest';
import { ROLE_KEYS } from '@mje/contracts';
import type { PersonnelRevisionInput } from '../../contracts/src/personnel-metrics.js';
import { buildPersonnelWindow } from './personnel-metrics.js';

const projectId = '00000000-0000-4000-8000-000000000601';
const selectedAtUTC = '2026-10-06T20:00:00Z';
const categories = (raw: string) =>
  Object.fromEntries(ROLE_KEYS.map((key) => [key, raw]));
const row = (
  date: string,
  n = 1,
  raw = '2',
  suffix = n,
): PersonnelRevisionInput => ({
  projectId,
  businessDate: date,
  n,
  submitted: true,
  categories: categories(raw),
  reportRevisionId: `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`,
});
const build = (
  revisions: PersonnelRevisionInput[],
  toBusinessDate = '2026-10-06',
) =>
  buildPersonnelWindow({ projectId, toBusinessDate, selectedAtUTC, revisions });

describe('TEST declared category-day window CG-I07–10', () => {
  it('uses exactly seven selected local dates over month/year/leap boundaries, independently of selectedAt', () => {
    expect(
      build([], '2026-01-03').dayContributions.map((d) => d.businessDate),
    ).toEqual([
      '2025-12-28',
      '2025-12-29',
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
    ]);
    expect(build([], '2024-03-02').windowFrom).toBe('2024-02-25');
    expect(build([], '2024-03-02').dayContributions[4]!.businessDate).toBe(
      '2024-02-29',
    );
  });
  it('leaves unreported slots and all-unknown totals unknown, while explicit zero stays known', () => {
    const empty = build([]);
    expect(empty.totalState).toBe('missing');
    expect(empty.categoryKnownSubtotals.installer).toMatchObject({
      knownSubtotal: null,
      unreportedDays: 7,
    });
    expect(
      build([row('2026-10-06', 1, 'unknown')]).categoryKnownSubtotals.installer
        .knownSubtotal,
    ).toBeNull();
    expect(
      build([row('2026-10-06', 1, '0')]).categoryKnownSubtotals.installer,
    ).toMatchObject({
      knownSubtotal: '0',
      state: 'partial',
      valueDays: 1,
      unreportedDays: 6,
    });
  });
  it('preserves zero, blank, unknown, NA and absent field separately without source rewriting', () => {
    const input = row('2026-10-06');
    input.categories = {
      manager: ' 0 ',
      safetyOfficer: '',
      supervisor: 'unknown',
      subManager: 'na',
    };
    const result = build([input]);
    expect(result.dayContributions[6]!.categories).toEqual({
      manager: { raw: ' 0 ', state: 'value', count: '0' },
      safetyOfficer: { raw: '', state: 'blank', count: null },
      supervisor: { raw: 'unknown', state: 'unknown', count: null },
      subManager: { raw: 'na', state: 'na', count: null },
      installer: { raw: null, state: 'missing', count: null },
    });
    expect(result.categoryKnownSubtotals.installer).toMatchObject({
      missingFieldDays: 1,
      unreportedDays: 6,
    });
    expect(input.categories.manager).toBe(' 0 ');
  });
  it.each(['1.5', '-1', 'TEST raw', '100000000000000'])(
    'retains invalid count %s without rounding or summing it',
    (raw) => {
      const result = build([row('2026-10-06', 1, raw)]);
      expect(result.dayContributions[6]!.categories.installer).toEqual({
        raw,
        state: 'invalid',
        count: null,
      });
      expect(result.categoryKnownSubtotals.installer).toMatchObject({
        knownSubtotal: null,
        invalidDays: 1,
      });
    },
  );
  it('accepts mathematically integral decimal declarations while retaining their original text', () => {
    const result = build([row('2026-10-06', 1, '2,000000')]);
    expect(result.dayContributions[6]!.categories.installer).toEqual({
      raw: '2,000000',
      state: 'value',
      count: '2',
    });
  });
  it('does not add NA as zero, and reports full coverage only for seven specified slots', () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      row(`2026-10-0${i + 1}`, 1, 'na', i + 10),
    );
    expect(
      build(rows, '2026-10-07').categoryKnownSubtotals.installer,
    ).toMatchObject({ state: 'na', knownSubtotal: null, notApplicableDays: 7 });
    rows[0]!.categories = categories('0');
    expect(
      build(rows, '2026-10-07').categoryKnownSubtotals.installer,
    ).toMatchObject({
      state: 'complete',
      knownSubtotal: '0',
      valueDays: 1,
      notApplicableDays: 6,
    });
  });
  it('selects submitted revisions once, ignoring a higher draft and duplicate fact references', () => {
    const first = row('2026-10-06', 1, '2');
    const latest = row('2026-10-06', 2, '3');
    const draft = { ...row('2026-10-06', 3, '99'), submitted: false };
    const result = build([latest, first, draft, latest]);
    expect(result.categoryKnownSubtotals.installer.knownSubtotal).toBe('3');
    expect(result.dayContributions[6]).toMatchObject({
      n: 2,
      reportRevisionId: latest.reportRevisionId,
    });
    expect(result.reportedDays).toBe(1);
  });
  it('earlier-day correction replaces once in the current window and cannot mutate a frozen manifest', () => {
    const older = row('2026-10-01', 1, '2', 101);
    const today = row('2026-10-06', 1, '3', 106);
    const frozen = build([older, today]);
    const bytes = JSON.stringify(frozen);
    const corrected = row('2026-10-01', 2, '4', 201);
    expect(
      build([older, corrected, today]).categoryKnownSubtotals.installer
        .knownSubtotal,
    ).toBe('7');
    expect(frozen.categoryKnownSubtotals.installer.knownSubtotal).toBe('5');
    older.categories = categories('99');
    expect(JSON.stringify(frozen)).toBe(bytes);
    expect(frozen.dayContributions[1]!.reportRevisionId).toBe(
      older.reportRevisionId,
    );
  });
  it('excludes facts outside selected local dates without substituting selectedAt', () => {
    expect(
      build([row('2026-09-29', 1, '99'), row('2026-10-07', 1, '99', 7)])
        .reportedDays,
    ).toBe(0);
    expect(
      build([row('2026-09-30', 1, '2')]).categoryKnownSubtotals.installer
        .knownSubtotal,
    ).toBe('2');
  });
  it('sums exact large counts as strings and never exposes independent people, hours or person-days', () => {
    const result = build([
      row('2026-10-05', 1, '99999999999999', 5),
      row('2026-10-06', 1, '99999999999999', 6),
    ]);
    expect(result.categoryKnownSubtotals.installer.knownSubtotal).toBe(
      '199999999999998',
    );
    expect(Object.keys(result)).not.toContain('totalPeople');
    expect(Object.keys(result)).not.toContain('hours');
    expect(Object.keys(result)).not.toContain('personDays');
  });
  it('fails closed on cross-project, inconsistent revision identity, ambiguous version and invalid dates', () => {
    expect(() =>
      build([
        {
          ...row('2026-10-06'),
          projectId: '00000000-0000-4000-8000-000000000602',
        },
      ]),
    ).toThrow();
    const first = row('2026-10-06');
    expect(() =>
      build([first, { ...first, categories: categories('4') }]),
    ).toThrow();
    expect(() => build([first, row('2026-10-06', 1, '4', 2)])).toThrow();
    expect(() => build([], '2026-02-30')).toThrow();
    expect(() => build([{ ...first, n: 0 }])).toThrow();
  });
});
