import { describe, expect, it } from 'vitest';
import type { DayFactsDto, ReportItemDto } from '@mje/contracts';
import { blankFacts as blankRuleFacts } from '@mje/domain/rules';
import {
  activeWork,
  cumulativeChecks,
  cumulativeSuggestion,
  liveCoverage,
  savable,
  setFact,
} from './model.js';

const item = (kind: ReportItemDto['kind'], key: string): ReportItemDto => ({
  kind,
  key,
  label: key,
  unit: '',
  designQty: '',
  openingCumulative: '',
  sortOrder: 0,
  active: true,
});
// The empty facts of the rules and the boundary DTO have the same shape.
const blankFacts = () => blankRuleFacts() as DayFactsDto;
const items = [
  item('work', 'support'),
  item('work', 'rail'),
  item('machinery', 'crane'),
  item('material', 'rail'),
];
const baseline = { n: 1, rows: [{ item: 'support', target: '300' }] };

describe('report view model', () => {
  it('planned or already reported items come first; others wait behind a toggle', () => {
    const facts = blankFacts();
    expect(
      activeWork({ items, baseline, facts }).active.map((i) => i.key),
    ).toEqual(['support']);
    const withRail = setFact(facts, 'qty.rail', '5');
    expect(
      activeWork({ items, baseline, facts: withRail }).active.map((i) => i.key),
    ).toEqual(['support', 'rail']);
  });
  it('suggests cumulative from the carried value and keeps its date', () => {
    expect(
      cumulativeSuggestion({ value: '5390', asOf: '2026-09-29' }, '280'),
    ).toEqual({
      base: '5390',
      qty: '280',
      sum: '5670',
      asOf: '2026-09-29',
    });
    expect(cumulativeSuggestion(undefined, '280')).toBeNull();
    expect(
      cumulativeSuggestion({ value: 'unknown', asOf: '2026-09-29' }, '280'),
    ).toBeNull();
  });
  it('coverage lists missing items but hides photo reminders until photos exist', () => {
    const facts = setFact(blankFacts(), 'qty.support', '260');
    const cov = liveCoverage({ items, baseline, facts });
    expect(cov.missing.some((m) => m.key === 'photo')).toBe(false);
    expect(
      cov.missing.some((m) => m.key === 'cumulative' && m.item === 'support'),
    ).toBe(true);
  });
  it('invalid numbers keep the draft local; tokens and blanks are savable', () => {
    expect(savable(setFact(blankFacts(), 'qty.support', 'unknown'))).toBe(true);
    expect(savable(setFact(blankFacts(), 'qty.support', '12a'))).toBe(false);
    expect(savable(setFact(blankFacts(), 'people.manager', '1,5'))).toBe(true);
  });

  it('flags a cumulative below today and one that differs from last + today; skips unknown', () => {
    let f = setFact(blankFacts(), 'qty.support', '110');
    f = setFact(f, 'cumulative.support', '100');
    // first day (no earlier cumulative): 100 declared after today was corrected to 110
    expect(cumulativeChecks({ items, facts: f }, {})).toEqual([
      { item: 'support', kind: 'belowToday' },
    ]);
    const base = { support: { value: '500', asOf: '2026-09-28' } };
    f = setFact(f, 'cumulative.support', '600');
    expect(cumulativeChecks({ items, facts: f }, base)).toEqual([
      { item: 'support', kind: 'notSuggested', sum: '610' },
    ]);
    expect(
      cumulativeChecks(
        { items, facts: setFact(f, 'cumulative.support', '610') },
        base,
      ),
    ).toEqual([]);
    expect(
      cumulativeChecks(
        { items, facts: setFact(f, 'cumulative.support', 'unknown') },
        base,
      ),
    ).toEqual([]);
    expect(
      cumulativeChecks({ items, facts: setFact(f, 'qty.support', '') }, base),
    ).toEqual([]);
  });
});
