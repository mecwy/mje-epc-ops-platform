import { describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { ProjectHomeReader } from './reader.js';

const projectId = '11111111-1111-4111-8111-111111111111';

function fixturePool() {
  const moduleQueries: string[] = [];
  const client = {
    on() {},
    removeListener() {},
    release() {},
    async query(sql: string) {
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql)) return { rows: [] };
      if (sql.includes('set_config')) return { rows: [] };
      if (sql.includes('app_account_for_identity'))
        return {
          rows: [
            {
              orgId: 'TEST-org',
              id: 'TEST-account',
              personId: 'TEST-person',
              authzVersion: 1,
            },
          ],
        };
      if (sql.includes('clock_timestamp'))
        return { rows: [{ decidedAt: '2030-01-03T12:00:00.000Z' }] };
      if (sql.includes('FROM "Membership" WHERE'))
        return { rows: [{ role: 'EXECUTIVE_READER', projectId }] };
      if (sql.includes('project_managers_for_org')) {
        moduleQueries.push(sql);
        return { rows: [] };
      }
      if (sql.includes('FROM "Project" p JOIN "Membership"')) {
        moduleQueries.push(sql);
        if (sql.includes('"DailyClose"'))
          return {
            rows: [
              {
                id: projectId,
                code: 'TEST-1',
                name: 'TEST project',
                timezone: 'UTC',
                region: null,
                projectType: null,
                primaryWorkItemKey: null,
                today: '2030-01-03',
                access: 'read',
                items: [],
                snapshots: [],
                reportDays: [],
              },
            ],
          };
        if (sql.includes('"Issue"'))
          return {
            rows: [
              { projectId, issues: [], lagOpenKeys: [], lagDismissedKeys: [] },
            ],
          };
        if (sql.includes('"ProjectStatusUpdate"'))
          return {
            rows: [
              {
                projectId,
                latest: null,
                recent: [],
                previousStatus: null,
                expectationDueDates: [],
              },
            ],
          };
      }
      throw new Error(`unmatched TEST query: ${sql.slice(0, 120)}`);
    },
  } as unknown as PoolClient;
  return {
    moduleQueries,
    pool: { connect: async () => client } as unknown as Pool,
  };
}

describe('project home reader query bounds', () => {
  it('collects project home in four fixed module reads, below the six-query limit', async () => {
    const { moduleQueries, pool } = fixturePool();
    const result = await new ProjectHomeReader(pool).home(
      { tenantId: 'TEST-tenant', objectId: 'TEST-object' },
      { groupBy: 'region', status: null, query: '', page: 1, size: 50 },
    );
    expect(result.total).toBe(1);
    expect(moduleQueries).toHaveLength(4);
    expect(
      moduleQueries.some((sql) => sql.includes('project_managers_for_org')),
    ).toBe(true);
  });
});
