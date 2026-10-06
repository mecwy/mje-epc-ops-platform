import { describe, expect, it } from 'vitest';
import { InvalidReportInput } from './parse.js';
import {
  parseSourceReport,
  type SourceReportV1,
  type SourceReportV2,
  type SourceReportV3,
} from './report-source.js';

function source(): SourceReportV1 {
  return {
    schemaVersion: 1,
    documents: {
      testDoc: { sha256: 'a'.repeat(64), label: 'TEST source', format: 'docx' },
    },
    peopleTotal: {
      raw: ' 7 ',
      state: 'value',
      at: {
        document: 'testDoc',
        table: 0,
        row: 1,
        cell: 2,
        gridSpan: 2,
        verticalMerge: 'restart',
      },
    },
    workPercent: {},
    materials: {},
  };
}
describe('strict source declarations', () => {
  const nextSource = (): SourceReportV2 => ({
    ...source(),
    schemaVersion: 2,
    reportedNextPlan: {
      targetBusinessDate: '2028-02-29',
      quantities: {
        testWork: { ...source().peopleTotal!, raw: ' 23 ' },
        blank: { ...source().peopleTotal!, raw: ' \n ', state: 'blank' },
        zero: { ...source().peopleTotal!, raw: '0' },
        unknown: { ...source().peopleTotal!, raw: '?', state: 'unknown' },
        na: { ...source().peopleTotal!, raw: 'N/A', state: 'na' },
      },
    },
  });
  it('keeps V2 targets, raw states and coordinates without inventing plan approval', () => {
    const v = nextSource();
    const parsed = parseSourceReport(v);
    expect(parsed).toEqual(v);
    v.reportedNextPlan.quantities.testWork!.raw = '999';
    expect(parsed.schemaVersion).toBe(2);
    if (parsed.schemaVersion === 2)
      expect(parsed.reportedNextPlan.quantities.testWork!.raw).toBe(' 23 ');
    const onlyPlan = nextSource();
    delete onlyPlan.peopleTotal;
    expect(parseSourceReport(onlyPlan)).toEqual(onlyPlan);
  });
  it.each([
    [
      'bad date',
      (v: SourceReportV2) => ({
        ...v,
        reportedNextPlan: {
          ...v.reportedNextPlan,
          targetBusinessDate: '2027-02-29',
        },
      }),
    ],
    [
      'empty rows',
      (v: SourceReportV2) => ({
        ...v,
        reportedNextPlan: { ...v.reportedNextPlan, quantities: {} },
      }),
    ],
    ['null', (v: SourceReportV2) => ({ ...v, reportedNextPlan: null })],
    [
      'approval claim',
      (v: SourceReportV2) => ({
        ...v,
        reportedNextPlan: { ...v.reportedNextPlan, approved: true },
      }),
    ],
    ['V1 extra', (v: SourceReportV2) => ({ ...v, schemaVersion: 1 })],
    ['unsupported schema', (v: SourceReportV2) => ({ ...v, schemaVersion: 4 })],
    [
      'too many rows',
      (v: SourceReportV2) => ({
        ...v,
        reportedNextPlan: {
          ...v.reportedNextPlan,
          quantities: Object.fromEntries(
            Array.from({ length: 101 }, (_, i) => [`w${i}`, v.peopleTotal]),
          ),
        },
      }),
    ],
  ] as const)('rejects invalid V2 %s', (_name, change) => {
    expect(() => parseSourceReport(change(nextSource()))).toThrow(
      InvalidReportInput,
    );
  });
  it('counts the added plan cells within the existing total source-cell limit', () => {
    const v = nextSource();
    v.materials = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [
        `m${i}`,
        {
          cumulative: v.peopleTotal!,
          percent: v.peopleTotal!,
          unit: v.peopleTotal!,
          note: v.peopleTotal!,
        },
      ]),
    );
    v.workPercent = Object.fromEntries(
      Array.from({ length: 99 }, (_, i) => [`w${i}`, v.peopleTotal!]),
    );
    expect(() => parseSourceReport(v)).toThrow(InvalidReportInput);
  });
  it('copies raw bytes, explicit states and physical coordinates without normalizing', () => {
    const s = source();
    s.workPercent = { testWork: { ...s.peopleTotal!, raw: ' 25% ' } };
    s.materials = {
      testMaterial: {
        cumulative: { ...s.peopleTotal!, raw: '0' },
        percent: { ...s.peopleTotal!, raw: ' ? ', state: 'unknown' },
        note: { ...s.peopleTotal!, raw: ' \n ', state: 'blank' },
        unit: { ...s.peopleTotal!, raw: ' N/A ', state: 'na' },
      },
    };
    expect(parseSourceReport(s)).toEqual(s);
    const parsed = parseSourceReport(s);
    s.peopleTotal!.raw = '999';
    s.peopleTotal!.at.row = 42;
    expect(parsed.peopleTotal!.raw).toBe(' 7 ');
    expect(parsed.peopleTotal!.at.row).toBe(1);
  });
  it.each([
    null,
    [],
    {},
    { ...source(), schemaVersion: 2 },
    { ...source(), documents: {} },
    { ...source(), workPercent: [] },
    { ...source(), materials: { empty: {} } },
    { ...source(), peopleTotal: undefined },
    { ...source(), peopleTotal: null },
    {
      schemaVersion: 1,
      documents: source().documents,
      workPercent: {},
      materials: {},
    },
  ])('rejects malformed or empty source %j', (value) => {
    expect(() => parseSourceReport(value)).toThrow(InvalidReportInput);
  });
  it.each(['extra', 'rawCells', 'url', 'orgId'])(
    'refuses undocumented %s without echoing untrusted text',
    (key) => {
      expect(() => parseSourceReport({ ...source(), [key]: 'TEST' })).toThrow(
        'facts.sourceReport.extra',
      );
      expect(() =>
        parseSourceReport({
          ...source(),
          peopleTotal: { ...source().peopleTotal, [key]: 'TEST' },
        }),
      ).toThrow(InvalidReportInput);
    },
  );
  it.each(['value', 'blank'] as const)(
    'checks raw/state consistency for %s',
    (state) => {
      expect(() =>
        parseSourceReport({
          ...source(),
          peopleTotal: {
            ...source().peopleTotal,
            raw: state === 'blank' ? '0' : '  ',
            state,
          },
        }),
      ).toThrow(InvalidReportInput);
    },
  );
  it.each([-1, 1.5, 10001, '0', null])(
    'refuses invalid coordinate %j',
    (row) => {
      const s = source();
      expect(() =>
        parseSourceReport({
          ...s,
          peopleTotal: { ...s.peopleTotal, at: { ...s.peopleTotal!.at, row } },
        }),
      ).toThrow(InvalidReportInput);
    },
  );
  it('rejects missing document references, extra coordinate fields and invalid merge metadata', () => {
    for (const at of [
      { ...source().peopleTotal!.at, document: 'constructor' },
      { ...source().peopleTotal!.at, url: 'https://example.invalid' },
      { ...source().peopleTotal!.at, gridSpan: 0 },
      { ...source().peopleTotal!.at, gridSpan: 1001 },
      { ...source().peopleTotal!.at, verticalMerge: 'other' },
    ])
      expect(() =>
        parseSourceReport({
          ...source(),
          peopleTotal: { ...source().peopleTotal, at },
        }),
      ).toThrow(InvalidReportInput);
  });
  it.each([
    '/private/TEST.docx',
    'C:\\TEST.docx',
    'https://example.invalid/TEST',
    'TEST\nsecret',
    '',
  ])('rejects a path, URL or control character in a label: %j', (label) => {
    expect(() =>
      parseSourceReport({
        ...source(),
        documents: { testDoc: { ...source().documents['testDoc'], label } },
      }),
    ).toThrow(InvalidReportInput);
  });
  it('bounds maps, total cells, raw text, labels and hashes', () => {
    const s = source();
    const cells = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`test${i}`, s.peopleTotal!]),
      );
    expect(() => parseSourceReport({ ...s, workPercent: cells(101) })).toThrow(
      InvalidReportInput,
    );
    expect(() =>
      parseSourceReport({
        ...s,
        documents: Object.fromEntries(
          Array.from({ length: 5 }, (_, i) => [
            `d${i}`,
            s.documents['testDoc'],
          ]),
        ),
      }),
    ).toThrow(InvalidReportInput);
    expect(() =>
      parseSourceReport({
        ...s,
        peopleTotal: { ...s.peopleTotal, raw: 'x'.repeat(501) },
      }),
    ).toThrow(InvalidReportInput);
    for (const change of [
      { label: 'x'.repeat(201) },
      { sha256: 'A'.repeat(64) },
      { format: 'html' },
    ])
      expect(() =>
        parseSourceReport({
          ...s,
          documents: { testDoc: { ...s.documents['testDoc'], ...change } },
        }),
      ).toThrow(InvalidReportInput);
    const full = {
      ...s,
      workPercent: cells(100),
      materials: Object.fromEntries(
        Array.from({ length: 100 }, (_, i) => [
          `test${i}`,
          {
            cumulative: s.peopleTotal!,
            percent: s.peopleTotal!,
            unit: s.peopleTotal!,
            note: s.peopleTotal!,
          },
        ]),
      ),
    };
    expect(() => parseSourceReport(full)).toThrow(InvalidReportInput); // 501 cells
    delete full.peopleTotal;
    expect(parseSourceReport(full).workPercent).toEqual(cells(100)); // 500 cells
  });
  it('reports hostile map keys by position without leaking them', () => {
    const hostile = 'TEST\n' + 'z'.repeat(1000);
    expect(() =>
      parseSourceReport({
        ...source(),
        workPercent: { [hostile]: source().peopleTotal },
      }),
    ).toThrow('facts.sourceReport.workPercent[0]');
  });
});

const milestoneSource = (): SourceReportV3 => ({
  ...source(),
  schemaVersion: 3,
  milestones: {
    testMilestone: {
      plannedFinish: { ...source().peopleTotal!, raw: 'TEST original date' },
      actualFinish: { ...source().peopleTotal!, raw: ' ', state: 'blank' },
      reportedDelayDays: { ...source().peopleTotal!, raw: '0' },
      note: { ...source().peopleTotal!, raw: 'TEST merged note' },
    },
    next: {
      note: {
        ...source().peopleTotal!,
        raw: '',
        state: 'blank',
        at: { ...source().peopleTotal!.at, row: 2, verticalMerge: 'continue' },
      },
    },
    unknown: {
      actualFinish: { ...source().peopleTotal!, raw: '?', state: 'unknown' },
    },
    na: { actualFinish: { ...source().peopleTotal!, raw: 'N/A', state: 'na' } },
  },
});
describe('V3 original milestones', () => {
  it('retains dates verbatim, blank/zero/unknown/na and merge provenance, with no invented next plan', () => {
    const v = milestoneSource();
    const parsed = parseSourceReport(v);
    expect(parsed).toEqual(v);
    expect(parsed).not.toHaveProperty('reportedNextPlan');
    v.milestones.testMilestone!.note!.raw = 'edited';
    if (parsed.schemaVersion === 3)
      expect(parsed.milestones.testMilestone!.note!.raw).toBe(
        'TEST merged note',
      );
  });
  it('retains optional V2 next plan on V3 without changing V2 contract', () => {
    const v = {
      ...milestoneSource(),
      reportedNextPlan: {
        targetBusinessDate: '2028-02-29',
        quantities: { testWork: source().peopleTotal! },
      },
    };
    expect(parseSourceReport(v)).toEqual(v);
    expect(() => parseSourceReport({ ...v, schemaVersion: 2 })).toThrow(
      InvalidReportInput,
    );
  });
  it.each([
    ['empty', { milestones: {} }],
    ['null', { milestones: null }],
    ['row empty', { milestones: { test: {} } }],
    ['row null', { milestones: { test: null } }],
    ['approval', { milestones: { test: { approved: true } } }],
    ['cell null', { milestones: { test: { actualFinish: null } } }],
    ['plan null', { reportedNextPlan: null }],
    [
      'invalid plan',
      {
        reportedNextPlan: {
          targetBusinessDate: '2027-02-29',
          quantities: { test: source().peopleTotal },
        },
      },
    ],
    [
      'too many rows',
      {
        milestones: Object.fromEntries(
          Array.from({ length: 101 }, (_, i) => [
            `test${i}`,
            { note: source().peopleTotal },
          ]),
        ),
      },
    ],
  ])('rejects %s', (_name, patch) =>
    expect(() => parseSourceReport({ ...milestoneSource(), ...patch })).toThrow(
      InvalidReportInput,
    ),
  );
  it('includes milestone cells in the shared 500-cell budget', () => {
    const v = milestoneSource();
    v.materials = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [
        `test${i}`,
        {
          note: v.peopleTotal!,
          cumulative: v.peopleTotal!,
          unit: v.peopleTotal!,
          percent: v.peopleTotal!,
        },
      ]),
    );
    v.milestones = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [
        `test${i}`,
        { actualFinish: v.peopleTotal! },
      ]),
    );
    expect(() => parseSourceReport(v)).toThrow(InvalidReportInput);
    delete v.peopleTotal;
    expect(parseSourceReport(v)).toEqual(v);
  });
});
