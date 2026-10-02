import { describe, expect, it } from 'vitest';
import {
  aggregateProjectAttention,
  aggregateProjectHome,
  aggregateProjectOverview,
} from './aggregate.js';

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

  it('uses carried cumulative values and the first submission time for corrected reports', () => {
    const data = {
      report: {
        projects: [
          report({
            snapshots: [
              {
                businessDate: '2030-01-03',
                submittedAt: '2030-01-10T12:00:00.000Z',
                firstSubmittedAt: '2030-01-03T12:00:00.000Z',
                primaryWorkItemKey: 'module',
                items: [
                  {
                    kind: 'work',
                    key: 'module',
                    label: 'TEST module',
                    unit: 'm',
                    designQty: '10',
                    openingCumulative: '0',
                    sortOrder: 1,
                    active: true,
                  },
                ],
                facts: {
                  qty: {},
                  cumulative: { module: '' },
                  cumulativeCarry: {
                    module: { value: '5', asOf: '2030-01-02' },
                  },
                  people: {},
                  milestones: {},
                },
              },
            ],
          }),
        ],
      },
      statuses: {
        projects: [
          {
            projectId: ID,
            latest: null,
            recent: [],
            previousStatus: null,
            expectationDueDates: [
              {
                businessDate: '2030-01-03',
                cutoff: '2030-01-03T18:00:00.000Z',
              },
            ],
          },
        ],
      },
      issues: {
        projects: [
          { projectId: ID, issues: [], lagOpenKeys: [], lagDismissedKeys: [] },
        ],
      },
      managers: [],
      query: { groupBy: 'region', status: null, query: '', page: 1, size: 50 },
    } as never;
    const card = aggregateProjectHome(data).groups[0]?.projects[0];
    expect(card?.completion).toEqual({
      state: 'COMPUTABLE',
      percent: '50.0',
      aboveDesign: false,
    });
    expect(card?.hints).not.toContainEqual({
      code: 'MISSING_REPORT',
      count: 1,
    });
  });

  it('applies status counts before status filtering and paginates projects globally', () => {
    const projects = Array.from({ length: 120 }, (_, index) => {
      const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      return report({
        id,
        code: `TEST-${String(index).padStart(3, '0')}`,
        region: `R${index % 3}`,
      });
    });
    const statuses = projects.map((project) => ({
      projectId: project.id,
      latest: null,
      recent: [],
      previousStatus: null,
      expectationDueDates: [],
    }));
    const issues = projects.map((project) => ({
      projectId: project.id,
      issues: [],
      lagOpenKeys: [],
      lagDismissedKeys: [],
    }));
    const base = {
      report: { projects },
      statuses: { projects: statuses },
      issues: { projects: issues },
      managers: [],
    };
    const page = (page: number, status: 'NORMAL' | null = null) =>
      aggregateProjectHome({
        ...base,
        query: { groupBy: 'region', status, query: '', page, size: 50 },
      } as never);
    const first = page(1);
    const second = page(2);
    const third = page(3);
    expect(
      first.groups.reduce((n, group) => n + group.projects.length, 0),
    ).toBe(50);
    expect(
      second.groups.reduce((n, group) => n + group.projects.length, 0),
    ).toBe(50);
    expect(
      third.groups.reduce((n, group) => n + group.projects.length, 0),
    ).toBe(20);
    expect(first.counts.UNDECLARED).toBe(120);
    expect(page(1, 'NORMAL').total).toBe(0);
  });
});

describe('project attention ordering', () => {
  it('uses the escalation update time and compares mixed database timestamp formats by instant', () => {
    const projectId = ID;
    const issues = Array.from({ length: 51 }, (_, index) => ({
      id: `issue-${index}`,
      title: `TEST issue ${index}`,
      category: 'safety',
      createdOn: '2030-01-01',
      dueOn: null,
      state: 'OPEN',
      workItemKey: null,
      escalate: true,
      attentionAt: '2030-01-01T00:00:00.250+00:00',
    }));
    issues[50]!.attentionAt = '2030-01-01T01:00:00.500+01:00';
    const result = aggregateProjectAttention({
      report: { projects: [report()] },
      statuses: { projects: [{ projectId, latest: null, recent: [] }] },
      issues: {
        projects: [
          { projectId, issues, lagOpenKeys: [], lagDismissedKeys: [] },
        ],
      },
      managers: [],
    } as never);
    expect(result.items).toHaveLength(50);
    expect(result.items[0]?.id).toBe('issue-50');
    expect(result.items[0]?.at).toBe('2030-01-01T00:00:00.500Z');
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
