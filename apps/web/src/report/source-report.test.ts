import { parseFacts } from '@mje/contracts';
import { describe, expect, it, vi } from 'vitest';
import { blankFacts } from '@mje/domain/rules';
import { translate, type Lang } from '@mje/ui';
import type { SourceReportV1 } from '@mje/contracts';
import type { ReportContent } from '../api.js';
import { I18nProvider } from '../i18n.js';
import { ReportBody } from './ReportView.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SourceReport, type SourceReportLabels } from './SourceReport.js';
import {
  sourceReportModel,
  type ReportedCellDisplay,
  type SourceReportDisplayInput,
} from './source-report.js';

const cell = (
  raw: string,
  state: ReportedCellDisplay['state'] = 'value',
): ReportedCellDisplay => ({
  raw,
  state,
  citation: {
    label: 'TEST source',
    sha256: 'a'.repeat(64),
    table: 2,
    row: 3,
    cell: 4,
    gridSpan: 2,
    verticalMerge: 'continue',
  },
});
function input(): SourceReportDisplayInput {
  return {
    source: {
      peopleTotal: cell(' 7 '),
      workPercent: { test: cell('25% ') },
      materials: {
        test: {
          cumulative: cell('17.000001'),
          percent: cell(' 68%'),
          unit: cell('TEST-unit'),
          note: cell('TEST note'),
        },
      },
    },
    people: {
      manager: '1',
      safetyOfficer: '1',
      supervisor: '1',
      subManager: '1',
      installer: '4',
    },
    work: [
      { key: 'test', label: 'TEST work', cumulative: '64', design: '250' },
    ],
    materials: [
      {
        key: 'test',
        label: 'TEST material',
        unit: 'TEST-unit',
        today: '0',
        cumulative: { value: '17.000003', complete: true },
      },
    ],
  };
}
const captions = (language: string): SourceReportLabels => ({
  milestones: `${language} source milestones`,
  milestonesMissing: `${language} no source milestones`,
  plannedFinish: `${language} source planned finish`,
  actualFinish: `${language} source actual finish`,
  reportedDelayDays: `${language} source delay`,
  nextPlan: `${language} source tomorrow plan`,
  nextPlanMissing: `${language} no source tomorrow plan in this version`,
  targetDate: `${language} target date`,
  targetQuantity: `${language} source target`,
  approvalUnknown: `${language} approval unknown`,
  title: `${language} original comparison`,
  missingVersion: `${language} no original in this version`,
  unverifiedSource: `${language} source claim, unverified`,
  sourceUnavailable: `${language} source unavailable`,
  original: `${language} original`,
  blank: `${language} blank`,
  unknown: `${language} unknown`,
  na: `${language} not applicable`,
  absent: `${language} not recorded`,
  people: `${language} people`,
  classifiedTotal: `${language} classified total`,
  partialClassifiedTotal: `${language} partial classified sum`,
  workPercent: `${language} work percentage`,
  calculatedPercent: `${language} calculated percentage`,
  materials: `${language} materials`,
  today: `${language} today`,
  originalCumulative: `${language} original cumulative`,
  originalPercent: `${language} original percentage`,
  originalUnit: `${language} original unit`,
  originalNote: `${language} original note`,
  systemCumulative: `${language} system cumulative`,
  partialSystemCumulative: `${language} partial system cumulative`,
  unit: `${language} system unit`,
  equal: `${language} arithmetic equal`,
  unavailable: `${language} cannot compare`,
  partial: `${language} partial data`,
  unitMismatch: `${language} different units`,
  unitUnavailable: `${language} unit unavailable`,
  difference: (value) => `${language} arithmetic difference ${value}`,
  coordinates: (table, row, physicalCell) =>
    `${language} zero-based T${table}/R${row}/C${physicalCell}`,
  gridSpan: (value) => `${language} span ${value}`,
  verticalMerge: (value) => `${language} vertical ${value}`,
});
const render = (data: SourceReportDisplayInput, language = 'TEST-en') =>
  renderToStaticMarkup(
    createElement(SourceReport, {
      model: sourceReportModel(data),
      labels: captions(language),
    }),
  );

describe('original source comparison (presentation only)', () => {
  it('keeps original text separate from exact classified arithmetic', () => {
    const data = input(),
      before = JSON.stringify(data);
    const model = sourceReportModel(data);
    expect(model.people.original?.raw).toBe(' 7 ');
    expect(model.people.calculated).toBe('8');
    expect(model.people.comparison).toEqual({
      state: 'different',
      difference: '+1',
    });
    expect(JSON.stringify(data)).toBe(before);
  });
  it('does not label incomplete classifications as a full total or difference', () => {
    const data = { ...input(), people: { manager: '2', installer: 'unknown' } };
    const model = sourceReportModel(data);
    expect(model.people).toMatchObject({
      complete: false,
      calculated: '2',
      comparison: { state: 'partial' },
    });
    const html = render(data);
    expect(html).toContain('partial classified sum');
    const peopleSection = html
      .split('<section aria-label="TEST-en people">')[1]
      ?.split('</section>')[0];
    expect(peopleSection).toBeDefined();
    expect(peopleSection).not.toContain('arithmetic difference');
  });
  it('does not invent zero when no classification has a known count', () => {
    expect(
      sourceReportModel({ ...input(), people: {} }).people.calculated,
    ).toBeNull();
  });
  it('rejects fractional headcounts for arithmetic without changing their source', () => {
    const data = input();
    expect(
      sourceReportModel({
        ...data,
        people: { ...data.people, installer: '1.5' },
      }).people.complete,
    ).toBe(false);
    const model = sourceReportModel({
      ...data,
      source: { ...data.source!, peopleTotal: cell('1.5') },
    });
    expect(model.people.original?.raw).toBe('1.5');
    expect(model.people.comparison.state).toBe('unavailable');
  });
  it('preserves reported percent while reusing the existing rounded percentage calculation', () => {
    expect(sourceReportModel(input()).work[0]).toMatchObject({
      original: { raw: '25% ' },
      calculated: '25.6',
      comparison: { state: 'different', difference: '+0.6' },
    });
  });
  it.each(['', '0', 'unknown', 'na'])(
    'cannot calculate against design %j',
    (design) => {
      const data = input();
      const model = sourceReportModel({
        ...data,
        work: [{ ...data.work[0]!, design }],
      });
      expect(model.work[0]?.calculated).toBeNull();
      expect(model.work[0]?.comparison.state).toBe('unavailable');
    },
  );
  it.each(['1,234', '25,6%', '25%%', '25 kg', '1e2', '25.0000001%'])(
    'does not guess source notation %j',
    (raw) => {
      const data = input();
      const row = sourceReportModel({
        ...data,
        source: { ...data.source!, workPercent: { test: cell(raw) } },
      }).work[0]!;
      expect(row.original.raw).toBe(raw);
      expect(row.comparison.state).toBe('unavailable');
    },
  );
  it('keeps absent, blank, zero, unknown and not-applicable distinct', () => {
    const data = input();
    const source = {
      workPercent: {
        zero: cell('0'),
        blank: cell('  ', 'blank'),
        unknown: cell('TEST unknown', 'unknown'),
        na: cell('TEST N/A', 'na'),
      },
      materials: {},
    };
    const model = sourceReportModel({ ...data, source });
    expect(model.people.original).toBeUndefined();
    expect(
      model.work.map((row) => [row.original.raw, row.original.state]),
    ).toEqual([
      ['0', 'value'],
      ['  ', 'blank'],
      ['TEST unknown', 'unknown'],
      ['TEST N/A', 'na'],
    ]);
    const html = render({ ...data, source });
    for (const text of [
      'TEST-en not recorded',
      'TEST-en blank',
      'TEST-en unknown',
      'TEST-en not applicable',
      '>0<',
    ])
      expect(html).toContain(text);
  });
  it('does not treat unknown source text that looks numeric as a number', () => {
    const data = input();
    const model = sourceReportModel({
      ...data,
      source: { ...data.source!, peopleTotal: cell('8', 'unknown') },
    });
    expect(model.people.comparison.state).toBe('unavailable');
  });
  it('calculates material differences with six-decimal BigInt precision', () => {
    const row = sourceReportModel(input()).materials[0]!;
    expect(row.comparison).toEqual({
      state: 'different',
      difference: '+0.000002',
    });
    expect(row.today).toBe('0');
    expect(row.original.percent?.raw).toBe(' 68%');
  });
  it('handles values beyond safe floating-point precision without rounding', () => {
    const data = input();
    const source = {
      ...data.source!,
      materials: {
        test: {
          ...data.source!.materials.test,
          cumulative: cell('99999999999999.123456'),
        },
      },
    };
    const materials = [
      {
        ...data.materials[0]!,
        cumulative: { value: '99999999999999.123457', complete: true },
      },
    ];
    expect(
      sourceReportModel({ ...data, source, materials }).materials[0]
        ?.comparison,
    ).toEqual({ state: 'different', difference: '+0.000001' });
  });
  it('suppresses comparison for different or absent units', () => {
    const data = input();
    expect(
      sourceReportModel({
        ...data,
        materials: [{ ...data.materials[0]!, unit: 'another-unit' }],
      }).materials[0]?.comparison.state,
    ).toBe('unitMismatch');
    expect(
      sourceReportModel({
        ...data,
        materials: [{ ...data.materials[0]!, unit: '' }],
      }).materials[0]?.comparison.state,
    ).toBe('unitUnavailable');
    expect(
      sourceReportModel({
        ...data,
        source: {
          ...data.source!,
          materials: { test: { cumulative: cell('1') } },
        },
      }).materials[0]?.comparison.state,
    ).toBe('unitUnavailable');
  });
  it('never promotes a partial material sum to a complete cumulative comparison', () => {
    const data = input();
    const modified = {
      ...data,
      materials: [
        { ...data.materials[0]!, cumulative: { value: '3', complete: false } },
      ],
    };
    expect(sourceReportModel(modified).materials[0]?.comparison.state).toBe(
      'partial',
    );
    expect(render(modified)).toContain('partial system cumulative');
  });
  it('keeps a source-only historical item visible without inventing master data', () => {
    const model = sourceReportModel({ ...input(), work: [], materials: [] });
    expect(model.work[0]).toMatchObject({
      key: 'test',
      label: 'test',
      calculated: null,
      comparison: { state: 'unavailable' },
    });
    expect(model.materials[0]).toMatchObject({
      label: 'test',
      calculated: null,
      comparison: { state: 'unitUnavailable' },
    });
  });
  it('does not fill an old version with newer source data', () => {
    const data = input();
    const old = {
      people: data.people,
      work: data.work,
      materials: data.materials,
    };
    expect(sourceReportModel(data).recorded).toBe(true);
    expect(sourceReportModel(old).recorded).toBe(false);
    const html = render(old);
    expect(html).toContain('no original in this version');
    expect(html).not.toContain('TEST source');
    expect(html).not.toContain('classified total');
  });
  it('renders declared coordinates and merge metadata as unverified plain text', () => {
    const html = render(input());
    for (const text of [
      'source claim, unverified',
      'TEST source',
      'SHA-256:',
      'zero-based T2/R3/C4',
      'span 2',
      'vertical continue',
    ])
      expect(html).toContain(text);
    expect(html).not.toMatch(/<(a|input|button|form)\b/);
  });
  it('does not turn malicious source text or document labels into executable HTML or links', () => {
    const payload = '<img src=x onerror=alert(1)>https://invalid.example/TEST';
    const data = input(),
      malicious = cell(payload);
    const modified = {
      ...data,
      source: {
        ...data.source!,
        peopleTotal: {
          ...malicious,
          citation: { ...malicious.citation!, label: '<script>TEST</script>' },
        },
      },
    };
    const html = render(modified);
    expect(html).toContain('&lt;img');
    expect(html).toContain('&lt;script&gt;TEST&lt;/script&gt;');
    expect(html).not.toMatch(/<(script|img|a)\b/);
    expect(html).toContain('white-space:pre-wrap');
  });
  it('shows missing citation explicitly without claiming a verified source', () => {
    const data = input();
    expect(
      render({
        ...data,
        source: {
          ...data.source!,
          peopleTotal: { ...cell('7'), citation: null },
        },
      }),
    ).toContain('source unavailable');
  });
  it.each(['zh', 'en', 'sr', 'es'])(
    'uses injected %s captions, including state and provenance labels',
    (language) => {
      const html = render(input(), `TEST-${language}`);
      expect(html).toContain(`TEST-${language} original comparison`);
      expect(html).toContain(`TEST-${language} source claim, unverified`);
      expect(html).toContain(`TEST-${language} arithmetic difference +1`);
      if (language !== 'en') expect(html).not.toContain('TEST-en');
    },
  );
});

describe('selected-version source adapter in the actual report body', () => {
  it('keeps source targets in the selected work-item order after JSON object keys are reordered in storage', () => {
    const value = input();
    const source = {
      ...value.source!,
      reportedNextPlan: {
        targetBusinessDate: '2025-03-11',
        quantities: { aaa: cell(' ', 'blank'), test: cell('23') },
      },
    };
    const model = sourceReportModel({ ...value, source });
    expect(model.nextPlan?.rows.map((row) => row.key)).toEqual(['test', 'aaa']);
  });
  const source: SourceReportV1 = {
    schemaVersion: 1,
    documents: {
      testDoc: {
        sha256: 'c'.repeat(64),
        label: 'TEST frozen source <img src=x>',
        format: 'docx',
      },
    },
    peopleTotal: {
      raw: ' 7 ',
      state: 'value',
      at: { document: 'testDoc', table: 0, row: 2, cell: 3 },
    },
    workPercent: {
      test: {
        raw: '25%',
        state: 'value',
        at: { document: 'testDoc', table: 0, row: 3, cell: 4 },
      },
    },
    materials: {},
  };
  const content = (): ReportContent => ({
    businessDate: '2025-03-10',
    facts: {
      ...blankFacts(),
      presence: {},
      sourceReport: structuredClone(source),
      people: {
        manager: '1',
        safetyOfficer: '1',
        supervisor: '1',
        subManager: '1',
        installer: '4',
      },
      cumulative: { test: '64' },
    },
    items: [
      {
        kind: 'work',
        key: 'test',
        label: 'TEST frozen work label',
        unit: 'set',
        designQty: '250',
        openingCumulative: '',
        sortOrder: 0,
        active: true,
      },
    ],
    baseline: null,
    nextPlan: { status: 'none', n: null, rows: [] },
    previousSubmittedDate: null,
    cumulativeBase: {},
    materialsCumulative: {},
    coverage: { missing: [], invalid: [] },
  });
  const page = (c: ReportContent, lang: Lang) => {
    vi.stubGlobal('localStorage', { getItem: () => lang });
    vi.stubGlobal('navigator', { languages: [lang] });
    try {
      return renderToStaticMarkup(
        createElement(I18nProvider, {
          children: createElement(ReportBody, {
            c,
            version: null,
            timeZone: 'UTC',
            photos: [],
          }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  };
  it.each(['zh', 'en', 'sr', 'es'] as const)(
    'renders selected source and frozen denominator in %s',
    (lang) => {
      const c = content();
      const before = JSON.stringify(c);
      const html = page(c, lang);
      expect(html).toContain(translate(lang, 'sourceTitle'));
      expect(html).toContain(translate(lang, 'sourceUnverified'));
      expect(html).toContain('25%');
      expect(html).toContain('25.6%');
      expect(html).toContain('TEST frozen work label');
      expect(html).toContain('TEST frozen source &lt;img src=x&gt;');
      expect(html).not.toContain('<img src=x>');
      expect(html).toContain('c'.repeat(64));
      expect(JSON.stringify(c)).toBe(before);
    },
  );
  it('keeps absent source on an old version instead of displaying a newer source', () => {
    const old = content();
    delete old.facts.sourceReport;
    const current = content();
    current.facts.sourceReport!.peopleTotal!.raw = '9';
    page(current, 'en');
    const html = page(old, 'en');
    expect(html).toContain(translate('en', 'sourceMissingVersion'));
    expect(html).not.toContain('c'.repeat(64));
    expect(html).not.toContain('TEST frozen source');
  });

  it.each(
    (['zh', 'en', 'sr', 'es'] as const).flatMap((lang) =>
      ([2, 3] as const).map((version) => ({ lang, version })),
    ),
  )(
    'shows selected source plan and milestones in $lang schema $version',
    ({ lang, version }) => {
      const old = content();
      const current = content();
      current.facts.sourceReport = parseFacts({
        ...current.facts,
        sourceReport: {
          ...source,
          schemaVersion: version,
          ...(version === 3
            ? {
                milestones: {
                  testMilestone: {
                    plannedFinish: {
                      ...source.peopleTotal!,
                      raw: 'TEST original date',
                    },
                    reportedDelayDays: {
                      ...source.peopleTotal!,
                      raw: ' ',
                      state: 'blank' as const,
                    },
                    note: {
                      ...source.peopleTotal!,
                      raw: 'TEST merged milestone note',
                    },
                  },
                },
              }
            : {}),
          reportedNextPlan: {
            targetBusinessDate: '2025-03-11',
            quantities: {
              test: { ...source.peopleTotal!, raw: ' 23 ' },
              unknownRow: { ...source.peopleTotal!, raw: ' ', state: 'blank' },
            },
          },
        },
      }).sourceReport!;
      // A current confirmed operational plan must not replace the original source target.
      current.nextPlan = {
        status: 'confirmed',
        n: 9,
        rows: [{ item: 'test', target: '987' }],
      };
      const before = JSON.stringify(current);
      const html = page(current, lang);
      expect(html).toContain(translate(lang, 'sourceNextPlan'));
      expect(html).toContain(translate(lang, 'sourceApprovalUnknown'));
      expect(html).toContain('2025-03-11');
      expect(html).toContain(' 23 ');
      expect(html).toContain('TEST frozen work label');
      expect(html).toContain(translate(lang, 'notFilled'));
      if (version === 3) {
        expect(html).toContain(translate(lang, 'sourceMilestones'));
        expect(html).toContain('TEST original date');
        expect(html).toContain(translate(lang, 'sourceReportedDelayDays'));
        expect(html).toContain('TEST merged milestone note');
      }
      expect(JSON.stringify(current)).toBe(before);
      const olderHtml = page(old, lang);
      expect(olderHtml).toContain(translate(lang, 'sourceMilestonesMissing'));
      expect(olderHtml).not.toContain('TEST merged milestone note');
      expect(olderHtml).toContain(translate(lang, 'sourceNextPlanMissing'));
      expect(olderHtml).not.toContain(' 23 ');
      expect(olderHtml).not.toContain(translate(lang, 'sourceApprovalUnknown'));
    },
  );
});

it('keeps physical merge continuation blank and orders original milestones by frozen items', () => {
  const start = cell('TEST merged note');
  const continuation = cell(' ', 'blank');
  const v = input();
  const model = sourceReportModel({
    ...v,
    milestones: [
      { key: 'z', label: 'TEST frozen first' },
      { key: 'a', label: 'TEST frozen second' },
    ],
    source: {
      ...v.source!,
      milestones: { a: { note: continuation }, z: { note: start } },
    },
  });
  expect(model.milestones?.map((row) => row.key)).toEqual(['z', 'a']);
  expect(model.milestones?.[1]?.original.note?.raw).toBe(' ');
  const html = renderToStaticMarkup(
    createElement(SourceReport, { model, labels: captions('en') }),
  );
  expect(html.match(/TEST merged note/g)).toHaveLength(1);
  expect(html).toContain('TEST frozen first');
  expect(html).toContain(captions('en').verticalMerge('continue'));
});
