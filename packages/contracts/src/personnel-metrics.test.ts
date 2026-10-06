import { describe, expect, it } from 'vitest';
import { ROLE_KEYS } from './report.js';
import { parsePeopleWindowSummary } from './personnel-metrics.js';
import { buildPersonnelWindow } from '../../domain/src/personnel-metrics.js';

const projectId = '00000000-0000-4000-8000-000000000601';
const make = () =>
  buildPersonnelWindow({
    projectId,
    toBusinessDate: '2026-01-03',
    selectedAtUTC: '2026-01-03T22:00:00Z',
    revisions: [
      {
        projectId,
        businessDate: '2026-01-01',
        reportRevisionId: '00000000-0000-4000-8000-000000000611',
        n: 1,
        submitted: true,
        categories: {
          installer: '0',
          manager: 'unknown',
          safetyOfficer: 'na',
          supervisor: '',
        },
      },
    ],
  });

describe('TEST personnel window boundary', () => {
  it('round-trips only the safe projection, including explicit zero and absent fields', () => {
    const value = make();
    expect(parsePeopleWindowSummary(JSON.parse(JSON.stringify(value)))).toEqual(
      value,
    );
    const day = value.dayContributions[4]!;
    expect(day.categories.installer).toEqual({
      raw: '0',
      state: 'value',
      count: '0',
    });
    expect(day.categories.subManager).toEqual({
      raw: null,
      state: 'missing',
      count: null,
    });
  });
  it.each(['orgId', 'personId', 'sourceReport', 'hours'])(
    'rejects an extra %s field',
    (field) => {
      expect(() =>
        parsePeopleWindowSummary({ ...make(), [field]: 'TEST' }),
      ).toThrow();
    },
  );
  it('rejects unexpected nested personal or source data', () => {
    const value = make();
    Object.assign(value.dayContributions[4]!, { personId: 'TEST' });
    expect(() => parsePeopleWindowSummary(value)).toThrow();
  });
  it.each(['schemaVersion', 'basis', 'policyVersion', 'slotDays'])(
    'rejects a different %s policy',
    (field) => {
      expect(() =>
        parsePeopleWindowSummary({ ...make(), [field]: 'TEST' }),
      ).toThrow();
    },
  );
  it('rejects skipped/duplicate dates, inconsistent windows and invalid dates', () => {
    for (const day of ['2026-01-02', '2026-02-30']) {
      const value = make();
      value.dayContributions[4]!.businessDate = day;
      expect(() => parsePeopleWindowSummary(value)).toThrow();
    }
    expect(() =>
      parsePeopleWindowSummary({ ...make(), windowTo: '2026-01-04' }),
    ).toThrow();
  });
  it('rejects a revision without a number, missing revision with values and incorrect coverage', () => {
    const value = make();
    value.dayContributions[4]!.n = null;
    expect(() => parsePeopleWindowSummary(value)).toThrow();
    expect(() =>
      parsePeopleWindowSummary({ ...make(), reportedDays: 7 }),
    ).toThrow();
    const other = make();
    other.dayContributions[0]!.categories.installer = {
      raw: '0',
      count: '0',
      state: 'value',
    };
    expect(() => parsePeopleWindowSummary(other)).toThrow();
    const bad = make();
    bad.categoryKnownSubtotals.installer.unreportedDays = 0;
    expect(() => parsePeopleWindowSummary(bad)).toThrow();
  });
  it('rejects count/state mismatch, unsafe counts and offset selection instants', () => {
    for (const count of [null, '0.5', '-1', '900719925474099200']) {
      const value = make();
      value.dayContributions[4]!.categories.installer.count = count;
      expect(() => parsePeopleWindowSummary(value)).toThrow();
    }
    expect(() =>
      parsePeopleWindowSummary({
        ...make(),
        selectedAtUTC: '2026-01-03T23:00:00+01:00',
      }),
    ).toThrow();
  });
  it('requires every category even when its subtotal is unknown', () => {
    const value = make();
    for (const key of ROLE_KEYS)
      expect(value.categoryKnownSubtotals[key]).toBeDefined();
    delete (value.categoryKnownSubtotals as Record<string, unknown>)['manager'];
    expect(() => parsePeopleWindowSummary(value)).toThrow();
  });
});
