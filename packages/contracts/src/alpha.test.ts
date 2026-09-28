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
  it('keeps TEST Word-shaped report cells, units, percentages and count conflicts as declarations', () => {
    const input = command();
    input.declaration.workItems = [];
    const blank = { state: 'BLANK', value: null };
    const unknown = { state: 'UNKNOWN', value: null };
    const sections = {
      originalRecorder: '',
      weather: 'TEST mixed',
      temperature: '',
      reportedDuration: '',
      sourceNote: 'TEST manual report',
      progress: [
        {
          id: '10000000-0000-4000-8000-000000000005',
          item: 'TEST bracket',
          scopeCandidate: 'TEST roof candidate',
          unit: '套',
          today: { state: 'VALUE', value: '0' },
          cumulative: blank,
          designTotal: unknown,
          reportedPercent: { state: 'VALUE', value: '17.3%' },
          nextPlan: { state: 'VALUE', value: '7' },
        },
      ],
      workforce: [
        {
          id: '10000000-0000-4000-8000-000000000006',
          category: 'TEST',
          role: 'A',
          count: { state: 'VALUE', value: '1' },
          scopeCandidate: '',
        },
        {
          id: '10000000-0000-4000-8000-000000000007',
          category: 'TEST',
          role: 'B',
          count: { state: 'VALUE', value: '2' },
          scopeCandidate: '',
        },
      ],
      machines: [
        {
          id: '10000000-0000-4000-8000-000000000008',
          equipment: 'TEST lift',
          location: '',
          count: blank,
          note: '',
        },
      ],
      materials: [
        {
          id: '10000000-0000-4000-8000-000000000009',
          item: 'TEST rail',
          unit: '米',
          today: { state: 'VALUE', value: '0' },
          cumulative: blank,
          designTotal: unknown,
          reportedPercent: blank,
          note: '',
          scopeCandidate: '',
        },
      ],
      milestones: [],
      photoReferences: [
        {
          id: '10000000-0000-4000-8000-000000000010',
          description: 'TEST image reference',
          source: 'TEST device',
          reportedTakenAt: '',
          watermark: 'TEST unrelated scope',
          scopeCandidate: 'TEST pending area',
        },
      ],
      qualityText: 'TEST inspection requested, result unknown',
      ehsText: '',
      constructionText: 'TEST work recorded',
      photoNotes: '',
    };
    const result = parseSaveAlphaCommand({
      ...input,
      declaration: {
        ...input.declaration,
        reportedHeadcount: { state: 'VALUE', value: '2' },
        reportedSections: sections,
      },
    });
    expect(result.declaration.reportedSections).toEqual(sections);
    expect(result.declaration.reportedSections?.photoReferences).toEqual(
      sections.photoReferences,
    );
    expect(result.declaration.reportedSections?.progress[0]?.today).toEqual({
      state: 'VALUE',
      value: '0',
    });
    expect(
      result.declaration.reportedSections?.progress[0]?.cumulative,
    ).toEqual(blank);
    expect(result.declaration.reportedSections?.machines[0]?.count).toEqual(
      blank,
    );
    expect(result.declaration.reportedHeadcount).toEqual({
      state: 'VALUE',
      value: '2',
    });
    expect(result.declaration).not.toHaveProperty('actualHours');
    const forged = structuredClone(sections) as typeof sections & {
      verified?: boolean;
    };
    forged.verified = true;
    expect(() =>
      parseSaveAlphaCommand({
        ...input,
        declaration: { ...input.declaration, reportedSections: forged },
      }),
    ).toThrow();
    const invalid = structuredClone(sections);
    invalid.progress[0]!.today = { state: 'BLANK', value: '0' };
    expect(() =>
      parseSaveAlphaCommand({
        ...input,
        declaration: { ...input.declaration, reportedSections: invalid },
      }),
    ).toThrow();
  });
});
