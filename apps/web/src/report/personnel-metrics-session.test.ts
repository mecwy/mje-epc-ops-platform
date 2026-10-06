import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ROLE_KEYS } from '@mje/contracts';
import type { PeopleWindowSummaryDto } from '../../../../packages/contracts/src/personnel-metrics.js';
import { ApiError } from '../api.js';
import { PersonnelMetricsSession } from './personnel-metrics-session.js';
import {
  PersonnelMetrics,
  type PersonnelMetricsLabels,
} from './PersonnelMetrics.js';

const projectId = '00000000-0000-4000-8000-000000000601';
function summary(value: string = '0'): PeopleWindowSummaryDto {
  const categories = Object.fromEntries(
    ROLE_KEYS.map((key) => [
      key,
      { raw: value, state: 'value' as const, count: value },
    ]),
  ) as PeopleWindowSummaryDto['dayContributions'][number]['categories'];
  return {
    schemaVersion: 1,
    projectId,
    windowFrom: '2026-09-30',
    windowTo: '2026-10-06',
    selectedAtUTC: '2026-10-06T20:00:00Z',
    basis: 'declared_category_day_sum',
    policyVersion: 'personnel-category-seven-slots-v1',
    reportedDays: 1,
    slotDays: 7,
    totalState: 'partial',
    dayContributions: Array.from({ length: 7 }, (_, i) => ({
      businessDate: i === 0 ? '2026-09-30' : `2026-10-0${i}`,
      reportRevisionId: i === 6 ? '00000000-0000-4000-8000-000000000611' : null,
      n: i === 6 ? 1 : null,
      categories:
        i === 6
          ? categories
          : (Object.fromEntries(
              ROLE_KEYS.map((key) => [
                key,
                { raw: null, state: 'missing', count: null },
              ]),
            ) as typeof categories),
    })),
    categoryKnownSubtotals: Object.fromEntries(
      ROLE_KEYS.map((key) => [
        key,
        {
          knownSubtotal: value,
          state: 'partial',
          valueDays: 1,
          blankDays: 0,
          unknownDays: 0,
          notApplicableDays: 0,
          invalidDays: 0,
          missingFieldDays: 0,
          unreportedDays: 6,
        },
      ]),
    ) as PeopleWindowSummaryDto['categoryKnownSubtotals'],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
}
const labels: PersonnelMetricsLabels = {
  title: 'TEST category declarations',
  description: 'TEST category-day sums; no deduplicated people or labor time',
  category: 'TEST category',
  knownSubtotal: 'TEST known subtotal',
  coverageTitle: 'TEST coverage',
  contributions: 'TEST revisions',
  state: 'TEST state',
  noValue: 'TEST unknown',
  loading: 'TEST loading',
  refreshError: 'TEST unavailable',
  retry: 'TEST refresh',
  historicalUnavailable: 'TEST not generated at submission',
  categories: Object.fromEntries(
    ROLE_KEYS.map((key) => [key, `TEST ${key}`]),
  ) as PersonnelMetricsLabels['categories'],
  cellStates: {
    value: 'TEST value',
    blank: 'TEST blank',
    unknown: 'TEST unknown',
    na: 'TEST NA',
    invalid: 'TEST invalid',
    missing: 'TEST unreported/absent',
  },
  totalStates: {
    complete: 'TEST complete',
    partial: 'TEST partial',
    unknown: 'TEST unknown',
    na: 'TEST NA',
    missing: 'TEST unreported',
  },
  period: (from, to) => `${from} / ${to}`,
  coverage: (reported, slots) => `${reported} / ${slots} TEST date slots`,
  categoryCoverage: (value) =>
    `${value.valueDays} TEST known / ${value.unreportedDays} TEST unreported`,
  selectedAt: (utc) => `TEST selected ${utc}`,
  openRevision: (date, n) => `TEST ${date} r${n}`,
};

describe('TEST personnel read session and isolated component', () => {
  it('uses the existing read fence so late success cannot replace a newer result', async () => {
    const first = deferred<PeopleWindowSummaryDto>();
    const second = deferred<PeopleWindowSummaryDto>();
    const queue = [first, second];
    const session = new PersonnelMetricsSession(
      { peopleWindow: () => queue.shift()!.promise },
      projectId,
      '2026-10-06',
    );
    const older = session.refresh();
    const newer = session.refresh();
    second.resolve(summary('4'));
    expect(await newer).toBe(true);
    first.resolve(summary('2'));
    expect(await older).toBe(false);
    expect(
      session.summary?.categoryKnownSubtotals.installer.knownSubtotal,
    ).toBe('4');
  });
  it('a newer denial hides prior data and fences an older successful response', async () => {
    const old = deferred<PeopleWindowSummaryDto>();
    const denied = deferred<PeopleWindowSummaryDto>();
    const queue = [Promise.resolve(summary()), old.promise, denied.promise];
    const session = new PersonnelMetricsSession(
      { peopleWindow: () => queue.shift()! },
      projectId,
      '2026-10-06',
    );
    await session.refresh();
    const late = session.refresh();
    const revoke = session.refresh();
    denied.reject(new ApiError('FORBIDDEN', 403));
    await revoke;
    old.resolve(summary('99'));
    await late;
    expect(session.summary).toBeNull();
    expect(session.read.readError).toBe('FORBIDDEN');
  });
  it.each([
    { projectId: 'TEST other' },
    { windowTo: '2026-10-07' },
    { basis: 'hours' },
    { slotDays: 8 },
  ])('refuses a mismatched read %j', async (change) => {
    const session = new PersonnelMetricsSession(
      {
        peopleWindow: async () =>
          ({ ...summary(), ...change }) as PeopleWindowSummaryDto,
      },
      projectId,
      '2026-10-06',
    );
    expect(await session.refresh()).toBe(false);
    expect(session.summary).toBeNull();
    expect(session.read.readError).toBe('INVALID_RESPONSE');
  });
  it('separate project/date sessions cannot rebind an in-flight read, and unsubscribe releases listeners', async () => {
    const pending = deferred<PeopleWindowSummaryDto>();
    const older = new PersonnelMetricsSession(
      { peopleWindow: () => pending.promise },
      projectId,
      '2026-10-06',
    );
    const otherProject = '00000000-0000-4000-8000-000000000602';
    const newer = new PersonnelMetricsSession(
      {
        peopleWindow: async () => ({
          ...summary('7'),
          projectId: otherProject,
        }),
      },
      otherProject,
      '2026-10-06',
    );
    let notices = 0;
    const unsubscribe = older.subscribe(() => {
      notices++;
    });
    const load = older.refresh();
    await newer.refresh();
    unsubscribe();
    pending.resolve(summary('2'));
    await load;
    expect(notices).toBe(0);
    expect(newer.summary?.categoryKnownSubtotals.installer.knownSubtotal).toBe(
      '7',
    );
  });
  it('network failure hides a stale current value; explicit refresh can recover without any command write', async () => {
    let calls = 0;
    const session = new PersonnelMetricsSession(
      {
        peopleWindow: async () => {
          calls++;
          if (calls === 2) throw new ApiError('NETWORK', 0);
          return summary('3');
        },
      },
      projectId,
      '2026-10-06',
    );
    await session.refresh();
    await session.refresh();
    expect(session.summary).toBeNull();
    const html = renderToStaticMarkup(
      createElement(PersonnelMetrics, {
        mode: 'current',
        session,
        labels,
        onOpenRevision: () => undefined,
      }),
    );
    expect(html).toContain('TEST unavailable');
    expect(html).toContain('role="alert"');
    expect(html).toContain(labels.retry);
    expect(html).not.toContain('TEST known subtotal');
    await session.refresh();
    expect(
      session.summary?.categoryKnownSubtotals.installer.knownSubtotal,
    ).toBe('3');
  });
  it('renders explicit zero, coverage and revision references without an editable second fact form', () => {
    const html = renderToStaticMarkup(
      createElement(PersonnelMetrics, {
        mode: 'frozen',
        summary: summary(),
        labels,
        onOpenRevision: () => undefined,
      }),
    );
    expect(html).toContain('personnel-summary-number">0</span>');
    expect(html).toContain('1 / 7 TEST date slots');
    expect(html).toContain('TEST 2026-10-06 r1');
    expect(html).toContain('TEST unreported/absent');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<form');
  });
  it('legacy frozen snapshots say not generated rather than calculating current metrics', () => {
    const html = renderToStaticMarkup(
      createElement(PersonnelMetrics, {
        mode: 'frozen',
        summary: null,
        labels,
        onOpenRevision: () => undefined,
      }),
    );
    expect(html).toContain('TEST not generated at submission');
    expect(html).not.toContain('personnel-summary-number">0</span>');
  });
  it('escapes original invalid text, and unknown subtotal is not zero', () => {
    const value = summary();
    value.dayContributions[6]!.categories.installer = {
      raw: '<script>TEST</script>',
      state: 'invalid',
      count: null,
    };
    value.categoryKnownSubtotals.installer.knownSubtotal = null;
    value.categoryKnownSubtotals.installer.state = 'unknown';
    const html = renderToStaticMarkup(
      createElement(PersonnelMetrics, {
        mode: 'frozen',
        summary: value,
        labels,
        onOpenRevision: () => undefined,
      }),
    );
    expect(html).toContain('&lt;script&gt;TEST&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('personnel-summary-number">TEST unknown</span>');
  });
  it('keeps period and coverage visible while cumulative rows and their methodology are in closed disclosures', () => {
    const html = renderToStaticMarkup(
      createElement(PersonnelMetrics, {
        mode: 'frozen',
        summary: summary('4'),
        labels,
        onOpenRevision: () => undefined,
      }),
    );
    const primary = html.split('<details')[0]!;
    const expanded = html.slice(html.indexOf('<details'));
    expect(primary).toContain(labels.title);
    expect(primary).toContain('2026-09-30 / 2026-10-06');
    expect(primary).toContain('1 / 7 TEST date slots');
    expect(primary).toContain('TEST partial');
    expect(primary).not.toContain(labels.description);
    expect(primary).not.toContain('TEST selected');
    expect(primary).not.toContain('TEST known /');
    expect(primary).not.toContain('<table');
    expect(primary).not.toContain('personnel-summary-number');
    expect(expanded.match(/scope="col"/g)).toHaveLength(2);
    expect(expanded).toContain('personnel-summary-totals');
    expect(expanded.match(/<details/g)).toHaveLength(2);
    expect(expanded).toContain(labels.description);
    expect(expanded).toContain('TEST selected 2026-10-06T20:00:00Z');
    expect(expanded).toContain('TEST 2026-10-06 r1');
    expect(html).not.toMatch(/<details[^>]*\bopen(?:=|[ >])/);
  });
  it('offers retry only after a failed read, not while loading or after success', async () => {
    const session = new PersonnelMetricsSession(
      { peopleWindow: async () => summary('4') },
      projectId,
      '2026-10-06',
    );
    const render = () =>
      renderToStaticMarkup(
        createElement(PersonnelMetrics, {
          mode: 'current',
          session,
          labels,
          onOpenRevision: () => undefined,
        }),
      );
    expect(render()).toContain('role="status"');
    expect(render()).not.toContain(labels.retry);
    await session.refresh();
    expect(render()).not.toContain(labels.retry);
  });

  it('distinguishes explicit zero, blank, unknown and NA in disclosed cumulative rows while retaining original daily states', () => {
    const value = summary();
    const cases = [
      ['supervisor', 'blank', 'blankDays', 'TEST blank'],
      ['safetyOfficer', 'unknown', 'unknownDays', 'TEST unknown'],
      ['subManager', 'na', 'notApplicableDays', 'TEST NA'],
    ] as const;
    for (const [key, state, counter] of cases) {
      Object.assign(value.categoryKnownSubtotals[key], {
        knownSubtotal: null,
        state: 'unknown',
        valueDays: 0,
        [counter]: 1,
      });
      value.dayContributions[6]!.categories[key] = {
        raw: state === 'blank' ? '' : state,
        state,
        count: null,
      };
    }
    const original = JSON.stringify(value);
    const html = renderToStaticMarkup(
      createElement(PersonnelMetrics, {
        mode: 'frozen',
        summary: value,
        labels,
        onOpenRevision: () => undefined,
      }),
    );
    const rows = html.slice(html.indexOf('<table'), html.indexOf('</table>'));
    expect(rows).toContain('personnel-summary-number">0</span>');
    for (const [, , , wording] of cases)
      expect(rows).toContain(`personnel-summary-number">${wording}</span>`);
    expect(html).toContain('unknown · TEST unknown');
    expect(html).toContain('na · TEST NA');
    expect(JSON.stringify(value)).toBe(original);
  });
  it('keeps current and frozen contexts and values independent, with optional compact labels', async () => {
    const frozen = summary('2');
    const original = JSON.stringify(frozen);
    const session = new PersonnelMetricsSession(
      { peopleWindow: async () => summary('4') },
      projectId,
      '2026-10-06',
    );
    await session.refresh();
    const compact = {
      ...labels,
      shortSubtotal: 'TEST reported count',
      cumulativeTitle: 'TEST show seven-day declared counts',
      detailsTitle: 'TEST details and basis',
      shortTotalStates: { partial: 'TEST partial short' },
    };
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(PersonnelMetrics, {
          mode: 'frozen',
          summary: frozen,
          labels: { ...compact, title: 'TEST frozen' },
          onOpenRevision: () => undefined,
        }),
        createElement(PersonnelMetrics, {
          mode: 'current',
          session,
          labels: { ...compact, title: 'TEST current' },
          onOpenRevision: () => undefined,
        }),
      ),
    );
    expect(html).toContain('TEST frozen');
    expect(html).toContain('TEST current');
    expect(html).toContain('personnel-summary-number">2</span>');
    expect(html).toContain('personnel-summary-number">4</span>');
    expect(html).toContain('TEST reported count');
    expect(html).toContain('TEST partial short');
    expect(html).toContain('<summary>TEST details and basis</summary>');
    expect(html.match(/<details/g)).toHaveLength(4);
    expect(
      html.match(/<summary>TEST show seven-day declared counts<\/summary>/g),
    ).toHaveLength(2);
    expect(html).not.toMatch(/<details[^>]*\bopen(?:=|[ >])/);
    expect(html).not.toContain(labels.retry);
    expect(JSON.stringify(frozen)).toBe(original);
  });
});
