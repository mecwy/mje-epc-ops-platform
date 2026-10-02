import { describe, expect, it } from 'vitest';
import { aggregateProjectHome, aggregateProjectOverview } from './aggregate.js';

const ID = '11111111-1111-4111-8111-111111111111';

function report(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    code: 'TEST-1',
    name: 'TEST project',
    timezone: 'UTC',
    region: null,
    projectType: null,
    primaryWorkItemKey: 'module',
    today: '2030-01-03',
    access: 'read',
    items: [],
    snapshots: [],
    reportDays: [],
    ...overrides,
  } as never;
}

describe('project home aggregation', () => {
  it('shows low-baseline hints only for three submitted days and excludes dismissed or open items', () => {
    const snapshots = ['2030-01-01', '2030-01-02', '2030-01-03'].map(
      (businessDate) => ({
        businessDate,
        submittedAt: `${businessDate}T12:00:00.000Z`,
        primaryWorkItemKey: 'module',
        items: [],
        milestones: [],
        baseline: { n: 1, rows: [{ item: 'module', target: '10' }] },
        facts: {
          qty: { module: '7' },
          cumulative: { module: '1' },
          people: {},
          milestones: {},
        },
      }),
    );
    const base = {
      report: { projects: [report({ snapshots })] },
      statuses: {
        projects: [
          {
            projectId: ID,
            latest: null,
            recent: [],
            previousStatus: null,
            expectationDueDates: [],
          },
        ],
      },
      issues: { projects: [{ projectId: ID, issues: [], lagOpenKeys: [] }] },
      managers: [],
      query: { groupBy: 'region', status: null, query: '', page: 1, size: 50 },
    } as never;
    expect(
      aggregateProjectHome(base).groups[0]?.projects[0]?.hints,
    ).toContainEqual({ code: 'BELOW_BASELINE', count: 1 });
    const excluded = {
      ...base,
      issues: {
        projects: [{ projectId: ID, issues: [], lagOpenKeys: ['module'] }],
      },
    } as never;
    expect(
      aggregateProjectHome(excluded).groups[0]?.projects[0]?.hints,
    ).not.toContainEqual({ code: 'BELOW_BASELINE', count: 1 });
  });
});

describe('project overview uses only frozen snapshot identity', () => {
  it('does not infer a primary item or milestone activity from mutable current master on legacy revisions', () => {
    const value = aggregateProjectOverview({
      report: report({
        items: [
          {
            kind: 'work',
            key: 'live-primary',
            label: 'TEST live',
            unit: 'm',
            designQty: '10',
            openingCumulative: '0',
            sortOrder: 1,
            active: true,
          },
        ],
        snapshots: [
          {
            businessDate: '2030-01-03',
            submittedAt: '2030-01-03T12:00:00.000Z',
            items: [],
            facts: { qty: {}, cumulative: {}, people: {}, milestones: {} },
          },
        ],
      }),
      history: { projectId: ID, currentN: 0, updates: [] },
      issues: [],
    } as never);
    expect(value.primaryWorkItem).toBeNull();
    expect(value.milestones).toEqual([]);
    expect(value.cumulative).toEqual([
      { businessDate: '2030-01-03', value: null },
    ]);
  });
});
