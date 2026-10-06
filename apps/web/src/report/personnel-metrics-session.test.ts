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
    expect(html).toContain('<td>0</td>');
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
    expect(html).not.toContain('<td>0</td>');
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
    expect(html).toContain('<td>TEST unknown</td>');
  });
});
