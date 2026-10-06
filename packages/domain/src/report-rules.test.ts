import { describe, expect, it } from 'vitest';
import {
  baseline,
  blankFacts,
  canCloseByPm,
  canEscalate,
  carryCumulative,
  carryMaterial,
  checkinDecision,
  confirmPlan,
  coverage,
  dec,
  decText,
  distanceM,
  foremanDateAllowed,
  foremanTotals,
  hasFacts,
  isDeviceFix,
  isReported,
  lagSuggestions,
  peopleTotal,
  pct,
  photoAcceptable,
  planRows,
  planStatus,
  sameForemanBasis,
  shiftDate,
  suggestCumulative,
  type ForemanBasis,
  type ForemanItemTotal,
  type ForemanReport,
  type PlanState,
} from './report-rules.js';

const ITEMS = ['support', 'rail', 'modules'];
const MACH = ['boomLift', 'crane', 'truck'];
const MATS = ['support', 'rail'];
const plan = (rows: [string, string][], draft = false): PlanState => ({
  versions: [
    {
      n: 1,
      rows: rows.map(([item, target]) => ({ item, target })),
      at: 'TEST',
    },
  ],
  draft: draft ? rows.map(([item, target]) => ({ item, target })) : null,
});
const cov = (
  facts = blankFacts(),
  b: PlanState | undefined = plan([
    ['support', '300'],
    ['rail', '500'],
  ]),
  photos: string[] = [],
) =>
  coverage({
    facts,
    itemIds: ITEMS,
    machineryIds: MACH,
    materialIds: MATS,
    baseline: baseline(b),
    photographedItems: new Set(photos),
  });
const keys = (c: ReturnType<typeof coverage>) =>
  c.missing.map((m) => m.key + (m.item ? ':' + m.item : ''));

describe('decimal', () => {
  it('adds without floats and formats percentages half-up', () => {
    expect(decText(dec('0.1')! + dec('0.2')!)).toBe('0.3');
    expect(pct(dec('5380'), dec('9600'))).toBe('56.0');
    expect(pct(dec('260'), dec('300'))).toBe('86.7');
    expect(pct(dec('1'), dec('0'))).toBeNull();
    expect(dec('18O')).toBeNull();
    expect(dec('1,5')).toBe(dec('1.5'));
  });
  it('distinguishes blank, tokens and numbers', () => {
    expect(isReported('')).toBe(true);
    expect(isReported('unknown')).toBe(true);
    expect(isReported('0')).toBe(true);
    expect(isReported('abc')).toBe(false);
  });
});

describe('plans', () => {
  it('baseline is the latest confirmed version; a draft is not a baseline', () => {
    const p = plan([['support', '300']]);
    expect(baseline(p)!.rows[0]!.target).toBe('300');
    p.draft = [{ item: 'support', target: '350' }];
    expect(baseline(p)!.rows[0]!.target).toBe('300');
    expect(planStatus(p)).toEqual({ status: 'draft', n: 1 });
    expect(planStatus(undefined)).toEqual({ status: 'none', n: null });
  });
  it('suggests yesterday baseline rows for an unplanned day without creating a version', () => {
    const rows = planRows(undefined, plan([['support', '300']]));
    expect(rows).toEqual([{ item: 'support', target: '300' }]);
  });
  it('a confirmed version is a copy: later draft edits do not reach it', () => {
    const draft = [{ item: 'support', target: '300' }];
    const outcome = confirmPlan({ versions: [], draft }, undefined, 'T');
    expect(outcome.ok).toBe(true);
    draft[0]!.target = '999';
    draft.push({ item: 'rail', target: '1' });
    if (outcome.ok)
      expect(outcome.version.rows).toEqual([
        { item: 'support', target: '300' },
      ]);
  });
  it('confirm creates a version once and never duplicates without a new draft', () => {
    const p: PlanState = {
      versions: [],
      draft: [{ item: 'support', target: '350' }],
    };
    const r = confirmPlan(p, undefined, 'T1');
    expect(r).toEqual({
      ok: true,
      version: { n: 1, rows: [{ item: 'support', target: '350' }], at: 'T1' },
    });
    const after: PlanState = {
      versions: [r.ok ? r.version : never()],
      draft: null,
    };
    expect(confirmPlan(after, undefined, 'T2')).toEqual({
      ok: false,
      reason: 'noChange',
    });
    expect(
      confirmPlan(
        { versions: [], draft: [{ item: 'x', target: '' }] },
        undefined,
        'T',
      ),
    ).toEqual({ ok: false, reason: 'emptyPlan' });
    expect(
      confirmPlan(
        { versions: [], draft: [{ item: 'x', target: '1O' }] },
        undefined,
        'T',
      ),
    ).toEqual({ ok: false, reason: 'numberInvalid' });
  });
});

describe('quantities', () => {
  it('cumulative suggestion = last submitted + today', () => {
    expect(suggestCumulative('5120', '260')).toEqual({
      base: '5120',
      qty: '260',
      sum: '5380',
    });
    expect(suggestCumulative(undefined, '260')).toBeNull();
    expect(suggestCumulative('5120', 'unknown')).toBeNull();
  });
  it('sums outside Decimal(20,6) are not offered as a suggestion', () => {
    expect(suggestCumulative('99999999999999.999999', '0.000001')).toBeNull();
    expect(suggestCumulative('99999999999999.999998', '0.000001')).toEqual({
      base: '99999999999999.999998',
      qty: '0.000001',
      sum: '99999999999999.999999',
    });
  });
});

describe('foreman totals (completeness, not a bare sum)', () => {
  const rep = (
    crew: string,
    n: number,
    rows: Record<string, string>,
  ): ForemanReport => ({
    crew,
    n,
    rows: Object.entries(rows).map(([item, qty]) => ({ item, qty })),
  });
  const status = (t: Record<string, ForemanItemTotal>, item: string) => [
    t[item]!.status,
    t[item]!.value,
    t[item]!.atLeast,
  ];
  it('a crew without a report is MISSING_REPORT: the item is PARTIAL, never a total', () => {
    const t = foremanTotals(
      ['B', 'C'],
      [rep('B', 1, { support: '260' })],
      ['support'],
    );
    expect(status(t, 'support')).toEqual(['PARTIAL', null, '260']);
    expect(t['support']!.crews['C']).toEqual({
      status: 'MISSING_REPORT',
      qty: null,
      expected: true,
    });
  });
  it('absent, blank and unknown are OMITTED/OMITTED/UNKNOWN and make the item PARTIAL', () => {
    const t = foremanTotals(
      ['B', 'C', 'D'],
      [
        rep('B', 1, { support: '10', rail: '' }),
        rep('C', 1, { support: 'unknown', rail: '4' }),
        rep('D', 1, { support: '5', rail: '6' }),
      ],
      ['support', 'rail', 'modules'],
    );
    expect(status(t, 'support')).toEqual(['PARTIAL', null, '15']);
    expect(t['support']!.crews['C']!.status).toBe('UNKNOWN');
    expect(status(t, 'rail')).toEqual(['PARTIAL', null, '10']);
    expect(t['rail']!.crews['B']).toEqual({
      status: 'OMITTED',
      qty: '',
      expected: true,
    });
    expect(status(t, 'modules')).toEqual(['PARTIAL', null, null]);
    expect(t['modules']!.crews['D']!.status).toBe('OMITTED');
  });
  it('an explicit zero from every expected crew is COMPLETE 0 (adoptable), not "no data"', () => {
    const t = foremanTotals(
      ['B', 'C'],
      [rep('B', 1, { support: '0' }), rep('C', 2, { support: '0.000' })],
      ['support'],
    );
    expect(status(t, 'support')).toEqual(['COMPLETE', '0', null]);
    expect(t['support']!.crews['B']!.status).toBe('ZERO');
  });
  it('numbers and n/a together are COMPLETE; all n/a is ALL_NA and not a number', () => {
    const t = foremanTotals(
      ['B', 'C'],
      [
        rep('B', 1, { support: '120.5', rail: 'na' }),
        rep('C', 1, { support: 'na', rail: 'na' }),
      ],
      ['support', 'rail'],
    );
    expect(status(t, 'support')).toEqual(['COMPLETE', '120.5', null]);
    expect(status(t, 'rail')).toEqual(['ALL_NA', null, null]);
  });
  it('a sum outside Decimal(20,6) is OVERFLOW with no number; a PARTIAL subtotal outside it is not shown', () => {
    const t = foremanTotals(
      ['B', 'C'],
      [
        rep('B', 1, { x: '99999999999999', y: '99999999999999' }),
        rep('C', 1, { x: '1', y: 'unknown' }),
      ],
      ['x', 'y'],
    );
    expect(status(t, 'x')).toEqual(['OVERFLOW', null, null]);
    expect(status(t, 'y')).toEqual(['PARTIAL', null, '99999999999999']);
    const big = foremanTotals(
      ['B', 'C', 'D'],
      [
        rep('B', 1, { x: '99999999999999' }),
        rep('C', 1, { x: '99999999999999' }),
      ],
      ['x'],
    );
    expect(status(big, 'x')).toEqual(['PARTIAL', null, null]);
  });
  it('an empty expected crew set is never COMPLETE nor ALL_NA', () => {
    expect(status(foremanTotals([], [], ['x']), 'x')).toEqual([
      'PARTIAL',
      null,
      null,
    ]);
  });
  it('the latest revision of each crew counts, by n (not by array order)', () => {
    const t = foremanTotals(
      ['B', 'C'],
      [
        rep('B', 2, { support: '265' }),
        rep('B', 1, { support: '260', rail: '180' }),
        rep('C', 1, { support: '40', rail: '0' }),
      ],
      ['support', 'rail'],
    );
    expect(status(t, 'support')).toEqual(['COMPLETE', '305', null]);
    // B's second revision left rail out: omitted now, not the superseded 180.
    expect(status(t, 'rail')).toEqual(['PARTIAL', null, '0']);
  });
  it('a report outside the expected set is never dropped: a number from it makes the item PARTIAL', () => {
    const t = foremanTotals(
      ['B'],
      [rep('B', 1, { x: '5', y: '5' }), rep('Z', 1, { x: '7', y: 'na' })],
      ['x', 'y'],
    );
    expect(status(t, 'x')).toEqual(['PARTIAL', null, '5']);
    expect(t['x']!.crews['Z']).toEqual({
      status: 'VALUE',
      qty: '7',
      expected: false,
    });
    expect(status(t, 'y')).toEqual(['COMPLETE', '5', null]);
  });
  it('items named only by a report are listed after the given ones; a stored non-number is UNKNOWN', () => {
    const t = foremanTotals(
      ['B'],
      [rep('B', 1, { zz: '1O', aa: '2' })],
      ['support'],
    );
    expect(Object.keys(t)).toEqual(['support', 'aa', 'zz']);
    expect(t['zz']!.crews['B']!.status).toBe('UNKNOWN');
  });
  it('a basis is the same only when the roster version, crew set and revisions all match', () => {
    const b: ForemanBasis = {
      rosterVersion: 4,
      expectedCrews: ['B', 'C'],
      revisions: [
        { crewId: 'B', n: 2 },
        { crewId: 'C', n: null },
      ],
    };
    expect(
      sameForemanBasis(b, {
        rosterVersion: 4,
        expectedCrews: ['C', 'B'],
        revisions: [
          { crewId: 'C', n: null },
          { crewId: 'B', n: 2 },
        ],
      }),
    ).toBe(true);
    expect(sameForemanBasis(b, { ...b, rosterVersion: 5 })).toBe(false);
    expect(sameForemanBasis(b, { ...b, expectedCrews: ['B'] })).toBe(false);
    expect(sameForemanBasis(b, { ...b, expectedCrews: ['B', 'C', 'C'] })).toBe(
      false,
    );
    expect(
      sameForemanBasis(b, {
        ...b,
        revisions: [
          { crewId: 'B', n: 2 },
          { crewId: 'C', n: 1 },
        ],
      }),
    ).toBe(false);
  });
  it('a foreman writes for the site today or yesterday only', () => {
    expect(foremanDateAllowed('2026-10-01', '2026-10-01')).toBe('ok');
    expect(foremanDateAllowed('2026-09-30', '2026-10-01')).toBe('ok');
    expect(foremanDateAllowed('2026-09-29', '2026-10-01')).toBe('tooOld');
    expect(foremanDateAllowed('2026-10-02', '2026-10-01')).toBe('future');
    // Across a month and a year end.
    expect(foremanDateAllowed('2026-12-31', '2027-01-01')).toBe('ok');
  });
});

describe('coverage', () => {
  it('lists missing planned quantities, narratives, people, machinery, materials, photos', () => {
    const f = blankFacts();
    f.qty['support'] = '260';
    const c = cov(f);
    for (const k of [
      'weather',
      'qty:rail',
      'cumulative:support',
      'photo:support',
      'construction',
      'quality',
      'safety',
      'people',
      'machinery',
      'materials',
    ])
      expect(keys(c)).toContain(k);
    expect(c.invalid).toEqual([]);
  });
  it('a photo linked to the item clears the photo reminder; zero needs no photo', () => {
    const f = blankFacts();
    f.qty['support'] = '260';
    expect(keys(cov(f, undefined, ['support']))).not.toContain('photo:support');
    f.qty['support'] = '0';
    expect(keys(cov(f))).not.toContain('photo:support');
  });
  it('no-work day has no missing items but still reports invalid numbers', () => {
    const f = blankFacts();
    f.noWork = { reason: 'weather', note: '' };
    f.qty['rail'] = '18O';
    const c = cov(f);
    expect(c.missing).toEqual([]);
    expect(c.invalid).toEqual([{ key: 'qty', item: 'rail' }]);
  });
  it('people total outside Decimal(20,6) is null', () => {
    expect(
      peopleTotal({ manager: '99999999999999.999999', installer: '0.000001' }),
    ).toBeNull();
  });
  it('people total ignores tokens and blanks', () => {
    expect(
      peopleTotal({ manager: '1', installer: '6', supervisor: 'unknown' }),
    ).toBe('7');
    expect(peopleTotal({})).toBeNull();
    expect(hasFacts(blankFacts())).toBe(false);
  });
});

describe('escalation reminder', () => {
  const day = (businessDate: string, q: string) => ({
    businessDate,
    baseline: baseline(plan([['support', '300']])),
    qty: { support: q },
  });
  const three = [
    day('2026-10-03', '200'),
    day('2026-10-02', '200'),
    day('2026-10-01', '200'),
  ];
  it('fires after 3 consecutive days under 80% of baseline, unless escalated or dismissed', () => {
    expect(lagSuggestions(three, new Set(), new Set())).toEqual(['support']);
    // exactly 80% is not under 80%
    expect(
      lagSuggestions(
        [day('2026-10-03', '200'), day('2026-10-02', '240'), three[2]!],
        new Set(),
        new Set(),
      ),
    ).toEqual([]);
    expect(lagSuggestions(three.slice(0, 2), new Set(), new Set())).toEqual([]);
    expect(lagSuggestions(three, new Set(['support']), new Set())).toEqual([]);
    expect(lagSuggestions(three, new Set(), new Set(['support']))).toEqual([]);
  });
  it('a gap in the history breaks the streak: three low entries on non-consecutive days do not fire', () => {
    expect(
      lagSuggestions(
        [
          day('2026-10-03', '200'),
          day('2026-10-01', '200'),
          day('2026-09-30', '200'),
        ],
        new Set(),
        new Set(),
      ),
    ).toEqual([]);
    // order of entries does not matter; dates do
    expect(
      lagSuggestions([three[2]!, three[0]!, three[1]!], new Set(), new Set()),
    ).toEqual(['support']);
  });
  it('issue rules: escalation needs a category; expert items are not PM-closable', () => {
    expect(canEscalate({ controlled: false, category: '' })).toBe(false);
    expect(canEscalate({ controlled: false, category: 'safety' })).toBe(true);
    expect(canCloseByPm({ controlled: true, category: 'quality' })).toBe(false);
  });
});

describe('photos and check-in', () => {
  it('in-app capture needs a real fix; album does not', () => {
    expect(photoAcceptable('camera', null)).toBe(false);
    const fix = {
      lat: 44.8,
      lon: 20.4,
      accuracyM: 12,
      fixAt: '2026-09-29T10:00:00Z',
    };
    expect(photoAcceptable('camera', fix)).toBe(true);
    expect(photoAcceptable('album', null)).toBe(true);
    // an object is not a fix: off-globe coordinates, negative/NaN accuracy or no fix time
    for (const bad of [
      { ...fix, lat: 999 },
      { ...fix, lon: -181 },
      { ...fix, lat: Number.NaN },
      { ...fix, accuracyM: -1 },
      { ...fix, accuracyM: null },
      { ...fix, accuracyM: Number.POSITIVE_INFINITY },
      { ...fix, fixAt: null },
      { ...fix, fixAt: '' },
      { ...fix, fixAt: 'yesterday' },
      { ...fix, fixAt: '   ' },
      { ...fix, fixAt: '2026-02-30T12:00:00Z' },
    ]) {
      expect(isDeviceFix(bad), JSON.stringify(bad)).toBe(false);
      expect(photoAcceptable('camera', bad)).toBe(false);
    }
  });
  it('proxy check-in only by the crew foreman or a manager, inside the fence, once a day', () => {
    const base = {
      person: 'W1',
      actor: 'W1',
      actorRole: 'worker' as const,
      actorCrew: 'B',
      personCrew: 'B',
      alreadyToday: false,
      distanceM: 40,
    };
    expect(checkinDecision(base)).toEqual({ ok: true });
    expect(checkinDecision({ ...base, alreadyToday: true })).toEqual({
      ok: false,
      reason: 'already',
    });
    expect(checkinDecision({ ...base, actor: 'W3' })).toEqual({
      ok: false,
      reason: 'proxyNotAllowed',
    });
    expect(
      checkinDecision({ ...base, actor: 'F1', actorRole: 'foreman' }),
    ).toEqual({ ok: true });
    expect(
      checkinDecision({
        ...base,
        actor: 'F9',
        actorRole: 'foreman',
        actorCrew: 'C',
      }),
    ).toEqual({ ok: false, reason: 'proxyNotAllowed' });
    expect(
      checkinDecision({
        ...base,
        actor: 'M1',
        actorRole: 'manager',
        actorCrew: null,
      }),
    ).toEqual({ ok: true });
    expect(checkinDecision({ ...base, distanceM: 900 })).toEqual({
      ok: false,
      reason: 'outsideSite',
    });
    // boundary: exactly the radius is inside; one metre more is outside
    expect(checkinDecision({ ...base, distanceM: 500 })).toEqual({ ok: true });
    expect(checkinDecision({ ...base, distanceM: 500.001 })).toEqual({
      ok: false,
      reason: 'outsideSite',
    });
    for (const d of [null, Number.NaN, -1, Number.NEGATIVE_INFINITY])
      expect(checkinDecision({ ...base, distanceM: d }), String(d)).toEqual({
        ok: false,
        reason: 'noLocation',
      });
    expect(() => checkinDecision({ ...base, radiusM: 0 })).toThrow(RangeError);
    expect(() => checkinDecision({ ...base, radiusM: Number.NaN })).toThrow(
      RangeError,
    );
  });
  it('distance and dates', () => {
    // 0.001° of longitude at 44° N is about 80 m
    const d = distanceM({ lat: 44, lon: 20 }, { lat: 44, lon: 20.001 });
    expect(d).toBeGreaterThan(75);
    expect(d).toBeLessThan(85);
    expect(distanceM({ lat: 44, lon: 20 }, { lat: 44, lon: 20 })).toBe(0);
    expect(distanceM({ lat: 91, lon: 20 }, { lat: 44, lon: 20 })).toBeNaN();
    expect(
      distanceM({ lat: 44, lon: 20 }, { lat: 44, lon: Number.NaN }),
    ).toBeNaN();
    expect(shiftDate('2026-09-30', 1)).toBe('2026-10-01');
  });
});

function never(): never {
  throw new Error('unreachable');
}

describe('carry-over between submitted days', () => {
  const f = (over: Partial<ReturnType<typeof blankFacts>> = {}) => ({
    ...blankFacts(),
    ...over,
  });
  const prev = { support: { value: '1210', asOf: '2026-10-05' } };
  it('a declared cumulative wins; nothing done keeps the last value with its date', () => {
    expect(
      carryCumulative(
        '2026-10-06',
        f({ cumulative: { support: '1300' } }),
        prev,
      ),
    ).toEqual({ support: { value: '1300', asOf: '2026-10-06' } });
    for (const qty of [{}, { support: '0' }, { support: 'na' }])
      expect(carryCumulative('2026-10-06', f({ qty }), prev)).toEqual(prev);
  });
  it('a no-work day hands the cumulative on unchanged (D1 → no work → D3)', () => {
    const d2 = carryCumulative(
      '2026-10-06',
      f({ noWork: { reason: 'weather', note: '' } }),
      prev,
    );
    expect(d2).toEqual(prev);
    expect(carryCumulative('2026-10-07', f(), d2)).toEqual(prev);
  });
  it('work declared without a cumulative drops the stale base', () => {
    for (const q of ['90', 'unknown'])
      expect(
        carryCumulative('2026-10-06', f({ qty: { support: q } }), prev),
      ).toEqual({});
  });
  it('material totals: numbers add, n/a and no-work blanks keep, blanks and unknown mark incomplete', () => {
    const base = { value: '100', complete: true };
    expect(carryMaterial(base, '5', false)).toEqual({
      value: '105',
      complete: true,
    });
    expect(carryMaterial(base, '0', false)).toEqual(base);
    expect(carryMaterial(base, 'na', false)).toEqual(base);
    expect(carryMaterial(base, '', true)).toEqual(base);
    expect(carryMaterial(base, '', false)).toEqual({
      value: '100',
      complete: false,
    });
    expect(carryMaterial(base, 'unknown', false)).toEqual({
      value: '100',
      complete: false,
    });
    // once incomplete, later receipts add but the total stays marked
    expect(
      carryMaterial({ value: '100', complete: false }, '5', false),
    ).toEqual({
      value: '105',
      complete: false,
    });
    expect(carryMaterial({ value: null, complete: false }, '5', false)).toEqual(
      {
        value: null,
        complete: false,
      },
    );
  });
  it('a material total outside Decimal(20,6) becomes unknown instead of an invalid number', () => {
    expect(
      carryMaterial(
        { value: '99999999999999.999999', complete: true },
        '1',
        false,
      ),
    ).toEqual({ value: null, complete: false });
  });
});

describe('source declarations are facts, never operational quantities', () => {
  it('recognizes milestone-only blank source without quantity, plan or completion', () => {
    const f = blankFacts();
    f.sourceReport = {
      schemaVersion: 3,
      documents: {
        test: { sha256: 'a'.repeat(64), label: 'TEST', format: 'docx' },
      },
      workPercent: {},
      materials: {},
      milestones: {
        testMilestone: {
          reportedDelayDays: {
            raw: ' ',
            state: 'blank',
            at: { document: 'test', table: 1, row: 1, cell: 3 },
          },
        },
      },
    };
    expect(hasFacts(f)).toBe(true);
    expect(f.qty).toEqual({});
    expect(f.milestones).toEqual({});
    expect(f.sourceReport).not.toHaveProperty('reportedNextPlan');
  });
  it('recognizes an explicitly blank source-plan cell without making an operational plan or quantity', () => {
    const f = blankFacts();
    f.sourceReport = {
      schemaVersion: 2,
      documents: {
        test: { sha256: 'a'.repeat(64), label: 'TEST', format: 'docx' },
      },
      workPercent: {},
      materials: {},
      reportedNextPlan: {
        targetBusinessDate: '2027-03-01',
        quantities: {
          test: {
            raw: ' ',
            state: 'blank',
            at: { document: 'test', table: 0, row: 1, cell: 0 },
          },
        },
      },
    };
    expect(hasFacts(f)).toBe(true);
    expect(f.qty).toEqual({});
    expect(f.cumulative).toEqual({});
  });
  it('counts a recorded blank cell but not documents alone; leaves numeric rules unchanged', () => {
    const f = blankFacts();
    f.sourceReport = {
      schemaVersion: 1,
      documents: {
        testDoc: {
          sha256: 'a'.repeat(64),
          label: 'TEST source',
          format: 'docx',
        },
      },
      workPercent: {},
      materials: {},
    };
    expect(hasFacts(f)).toBe(false);
    f.sourceReport.peopleTotal = {
      raw: '  ',
      state: 'blank',
      at: { document: 'testDoc', table: 0, row: 0, cell: 0 },
    };
    expect(hasFacts(f)).toBe(true);
    expect(peopleTotal(f.people)).toBeNull();
    f.sourceReport.peopleTotal = {
      ...f.sourceReport.peopleTotal,
      raw: '999',
      state: 'value',
    };
    expect(peopleTotal(f.people)).toBeNull();
    expect(f.qty).toEqual({});
    expect(f.materials).toEqual({});
  });
});

it('V4 source-only blank category note is a fact without implying people or labor', () => {
  const f = blankFacts();
  f.sourceReport = {
    schemaVersion: 4,
    documents: {
      test: { sha256: 'a'.repeat(64), label: 'TEST', format: 'docx' },
    },
    workPercent: {},
    materials: {},
    personnelRemarks: {
      installer: {
        raw: ' ',
        state: 'blank',
        at: { document: 'test', table: 3, row: 1, cell: 4 },
      },
    },
  };
  expect(hasFacts(f)).toBe(true);
  expect(f.people).toEqual({});
  expect(f.presence).toEqual({});
});

it('V5 blank source area or duration is a fact without assigning work or deriving progress', () => {
  const cell = {
    raw: ' ',
    state: 'blank' as const,
    at: { document: 'test', table: 2, row: 1, cell: 1 },
  };
  const f = blankFacts();
  f.sourceReport = {
    schemaVersion: 5,
    documents: {
      test: { sha256: 'a'.repeat(64), label: 'TEST', format: 'docx' },
    },
    workPercent: {},
    materials: {},
    workAreas: { testWork: cell },
  };
  expect(hasFacts(f)).toBe(true);
  delete f.sourceReport.workAreas;
  f.sourceReport.reportedDuration = { elapsed: cell };
  expect(hasFacts(f)).toBe(true);
  expect(f.qty).toEqual({});
  expect(f.cumulative).toEqual({});
});
