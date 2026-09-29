import { describe, expect, it } from 'vitest';
import {
  baseline,
  blankFacts,
  canCloseByPm,
  canEscalate,
  checkinDecision,
  confirmPlan,
  coverage,
  dec,
  decText,
  distanceM,
  foremanTotals,
  hasFacts,
  isReported,
  lagSuggestions,
  peopleTotal,
  pct,
  photoAcceptable,
  planRows,
  planStatus,
  shiftDate,
  suggestCumulative,
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
  it('foreman totals take the latest report per crew', () => {
    const t = foremanTotals([
      {
        crew: 'B',
        rows: [
          { item: 'support', qty: '260' },
          { item: 'rail', qty: '180' },
        ],
        at: '1',
      },
      { crew: 'B', rows: [{ item: 'support', qty: '265' }], at: '2' },
      { crew: 'C', rows: [{ item: 'support', qty: '40' }], at: '3' },
    ]);
    expect(t).toEqual({ support: '305' });
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
  it('people total ignores tokens and blanks', () => {
    expect(
      peopleTotal({ manager: '1', installer: '6', supervisor: 'unknown' }),
    ).toBe('7');
    expect(peopleTotal({})).toBeNull();
    expect(hasFacts(blankFacts())).toBe(false);
  });
});

describe('escalation reminder', () => {
  const day = (q: string) => ({
    baseline: baseline(plan([['support', '300']])),
    qty: { support: q },
  });
  it('fires after 3 days under 80% of baseline, unless escalated or dismissed', () => {
    expect(
      lagSuggestions(
        [day('200'), day('200'), day('200')],
        new Set(),
        new Set(),
      ),
    ).toEqual(['support']);
    expect(
      lagSuggestions(
        [day('200'), day('250'), day('200')],
        new Set(),
        new Set(),
      ),
    ).toEqual([]);
    expect(
      lagSuggestions([day('200'), day('200')], new Set(), new Set()),
    ).toEqual([]);
    expect(
      lagSuggestions(
        [day('200'), day('200'), day('200')],
        new Set(['support']),
        new Set(),
      ),
    ).toEqual([]);
    expect(
      lagSuggestions(
        [day('200'), day('200'), day('200')],
        new Set(),
        new Set(['support']),
      ),
    ).toEqual([]);
  });
  it('issue rules: escalation needs a category; expert items are not PM-closable', () => {
    expect(canEscalate({ controlled: false, category: '' })).toBe(false);
    expect(canEscalate({ controlled: false, category: 'safety' })).toBe(true);
    expect(canCloseByPm({ controlled: true, category: 'quality' })).toBe(false);
  });
});

describe('photos and check-in', () => {
  it('in-app capture needs a fix; album does not', () => {
    expect(photoAcceptable('camera', null)).toBe(false);
    expect(
      photoAcceptable('camera', { lat: 0, lon: 0, accuracyM: 12, fixAt: 'T' }),
    ).toBe(true);
    expect(photoAcceptable('album', null)).toBe(true);
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
    expect(checkinDecision({ ...base, distanceM: null })).toEqual({
      ok: false,
      reason: 'noLocation',
    });
  });
  it('distance and dates', () => {
    expect(
      Math.round(distanceM({ lat: 44, lon: 20 }, { lat: 44, lon: 20.001 })),
    ).toBeGreaterThan(70);
    expect(shiftDate('2026-09-30', 1)).toBe('2026-10-01');
  });
});

function never(): never {
  throw new Error('unreachable');
}
