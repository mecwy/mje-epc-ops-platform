import { describe, expect, it } from 'vitest';
import {
  followingBusinessDate,
  parseBusinessDate,
  parseSaveAlphaCommand,
} from './alpha.js';

function command() {
  return {
    recordId: '10000000-0000-4000-8000-000000000001',
    projectId: '10000000-0000-4000-8000-000000000002',
    expectedVersion: 0,
    baseRevisionNumber: null,
    clientMutationId: '10000000-0000-4000-8000-000000000003',
    action: 'SAVE_VERSION',
    reason: '',
    declaration: {
      businessDate: '2026-10-25',
      deviceRecordedAt: '2026-10-26T01:30:00+01:00',
      workItems: [
        {
          id: '10000000-0000-4000-8000-000000000004',
          area: 'TEST area',
          description: 'TEST work',
          quantity: { state: 'VALUE', value: '000.000000' },
          unit: '原报单位',
        },
      ],
      reportedHeadcount: { state: 'UNKNOWN', value: null },
      headcountNote: '',
      issues: '',
      tomorrow: { targetBusinessDate: '2026-10-26', text: '' },
    },
  };
}
describe('Alpha manual declaration contract', () => {
  it('retains raw zero, unit, unknown count, blank issues and original date across late receipt/DST', () => {
    const result = parseSaveAlphaCommand(command());
    expect(result.declaration).toEqual(command().declaration);
    expect(result.declaration).not.toHaveProperty('actualHours');
    expect(result.declaration).not.toHaveProperty('acceptedQuantity');
  });
  it.each(['BLANK', 'UNKNOWN', 'NOT_APPLICABLE'])(
    'retains %s independently from explicit zero',
    (state) => {
      const input = command();
      input.declaration.reportedHeadcount.state = state;
      expect(
        parseSaveAlphaCommand(input).declaration.reportedHeadcount,
      ).toEqual({ state, value: null });
    },
  );
  it.each(['orgId', 'actorId', 'role', 'siteTimezone', 'verified'])(
    'rejects caller-supplied %s',
    (key) => {
      expect(() =>
        parseSaveAlphaCommand({ ...command(), [key]: 'TEST-forgery' }),
      ).toThrow();
    },
  );
  it.each([
    '-1',
    '1e3',
    'Infinity',
    '0.0000001',
    '100000000000000',
    '1,000',
    ' 12 ',
  ])('rejects unsupported decimal %s without rounding', (value) => {
    const input = command();
    input.declaration.workItems[0]!.quantity.value = value;
    expect(() => parseSaveAlphaCommand(input)).toThrow();
  });
  it('requires raw unit for a reported value and rejects duplicate task ids', () => {
    const input = command();
    input.declaration.workItems[0]!.unit = '';
    expect(() => parseSaveAlphaCommand(input)).toThrow();
    const duplicate = command();
    duplicate.declaration.workItems.push(duplicate.declaration.workItems[0]!);
    expect(() => parseSaveAlphaCommand(duplicate)).toThrow();
  });
  it('rejects missing, fractional and negative concurrency versions', () => {
    for (const expectedVersion of [undefined, 1.1, -1, '1'])
      expect(() =>
        parseSaveAlphaCommand({ ...command(), expectedVersion }),
      ).toThrow();
  });
  it('does not let a next-day plan overwrite the current business day', () => {
    const input = command();
    input.declaration.tomorrow.targetBusinessDate = '2026-10-25';
    expect(() => parseSaveAlphaCommand(input)).toThrow();
  });
  it('validates real calendar dates and leap/month/year transitions', () => {
    expect(() => parseBusinessDate('2026-02-29')).toThrow();
    expect(() => parseBusinessDate('2026-02-31')).toThrow();
    expect(followingBusinessDate('2028-02-29')).toBe('2028-03-01');
    expect(followingBusinessDate('2026-12-31')).toBe('2027-01-01');
  });
  it('allows unfinished draft text without implying a saved immutable version', () => {
    const input = command();
    input.action = 'SAVE_DRAFT';
    input.declaration.workItems = [];
    expect(parseSaveAlphaCommand(input).action).toBe('SAVE_DRAFT');
    input.action = 'SAVE_VERSION';
    expect(() => parseSaveAlphaCommand(input)).toThrow();
  });
});
