import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  reportReader,
  readerSnapshot,
  observeReportProjections,
} from './report-reader.js';
import { withReportReadContext } from './report-read-context.js';
import { buildPersonnelWindow } from './personnel-metrics.js';
import type { Actor } from './store-kit.js';

const projectId = '10000000-0000-4000-8000-000000000001';
const revisionId = '20000000-0000-4000-8000-000000000001';
const actor: Actor = {
  orgId: 'TEST-org',
  accountId: 'TEST-account',
  personId: 'TEST-person',
  authzVersion: 1,
  decidedAt: '2026-10-06T12:00:00.000Z',
};
function client(
  options: { authorized?: boolean; exists?: boolean; rows?: unknown[] } = {},
) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM "Membership"'))
      return {
        rows:
          options.authorized === false
            ? []
            : [{ role: 'EXECUTIVE_READER', projectId }],
      };
    if (sql.includes('FROM "Project"'))
      return {
        rows:
          options.exists === false
            ? []
            : [{ id: projectId, timezone: 'Europe/Belgrade' }],
      };
    if (sql.includes('FROM "DailyClose"')) return { rows: options.rows ?? [] };
    throw new Error('Unexpected TEST query');
  });
  return { db: { query } as unknown as PoolClient, query };
}

// Synthetic TEST module-exit checks. PostgreSQL selection/transaction proofs are separate.
describe('personnel window authorized report exit', () => {
  it('refuses a revoked or unrelated membership before querying even an empty window', async () => {
    const { db, query } = client({ authorized: false });
    await expect(
      withReportReadContext(db, actor, (ctx) =>
        reportReader.forContext(ctx).peopleWindow(projectId, '2026-10-06'),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('FROM "Membership"');
  });
  it('refuses a project absent in the authorized tenant before inspecting report rows', async () => {
    const { db, query } = client({ exists: false });
    await expect(
      withReportReadContext(db, actor, (ctx) =>
        reportReader.forContext(ctx).peopleWindow(projectId, '2026-10-06'),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('projects seven unreported slots only after project authorization, with selected scope bounds', async () => {
    const { db, query } = client();
    const projections: string[] = [];
    observeReportProjections((value) => projections.push(value));
    try {
      const result = await withReportReadContext(db, actor, (ctx) =>
        reportReader.forContext(ctx).peopleWindow(projectId, '2026-10-06'),
      );
      expect(result.reportedDays).toBe(0);
      expect(result.categoryKnownSubtotals.installer.knownSubtotal).toBeNull();
      expect(result.dayContributions).toHaveLength(7);
      expect(projections).toEqual(['report.peopleWindow']);
      const sql = query.mock.calls[2]?.[0];
      expect(sql).toContain("r.state='SUBMITTED'");
      expect(sql).toContain('r."revisionNumber" DESC');
      expect(sql).not.toContain('d.state=');
      expect(query).toHaveBeenLastCalledWith(expect.any(String), [
        actor.orgId,
        projectId,
        'report',
        '2026-09-30',
        '2026-10-06',
      ]);
    } finally {
      observeReportProjections(null);
    }
  });
  it('serves only copied category declarations from selected submissions, excluding source totals and PII', async () => {
    const { db } = client({
      rows: [
        {
          projectId,
          businessDate: '2026-10-05',
          reportRevisionId: revisionId,
          n: 2,
          categories: {
            installer: '0',
            manager: 'unknown',
            personName: 'TEST-private',
          },
          sourceReport: { peopleTotal: '999' },
        },
      ],
    });
    const result = await withReportReadContext(db, actor, (ctx) =>
      reportReader.forContext(ctx).peopleWindow(projectId, '2026-10-06'),
    );
    expect(result.categoryKnownSubtotals.installer.knownSubtotal).toBe('0');
    expect(result.dayContributions[5]?.reportRevisionId).toBe(revisionId);
    expect(result.dayContributions[5]?.n).toBe(2);
    expect(JSON.stringify(result)).not.toContain('TEST-private');
    expect(JSON.stringify(result)).not.toContain('peopleTotal');
    expect(result.categoryKnownSubtotals.manager.knownSubtotal).toBeNull();
  });
  it('does not reopen an expired read context through the new entry', async () => {
    const { db, query } = client();
    const exit = await withReportReadContext(db, actor, async (ctx) =>
      reportReader.forContext(ctx),
    );
    await expect(exit.peopleWindow(projectId, '2026-10-06')).rejects.toThrow(
      'REPORT_READ_CONTEXT_CLOSED',
    );
    expect(query).not.toHaveBeenCalled();
  });
  it('retains the exact frozen summary and unrelated extensions without mutating the old snapshot', () => {
    const personnelSummary = buildPersonnelWindow({
      projectId,
      toBusinessDate: '2026-10-06',
      selectedAtUTC: actor.decidedAt,
      revisions: [],
    });
    const snapshot = {
      personnelSummary,
      extension: { test: 'unchanged' },
      field: { private: 'TEST' },
      nextPlan: { status: 'draft', rows: [{ test: 'hidden' }] },
    };
    const before = structuredClone(snapshot);
    const projected = readerSnapshot(snapshot);
    expect(projected['personnelSummary']).toEqual(personnelSummary);
    expect(projected['extension']).toEqual(snapshot.extension);
    expect(projected).not.toHaveProperty('field');
    expect(snapshot).toEqual(before);
    expect(readerSnapshot({ extension: 'TEST-legacy' })).not.toHaveProperty(
      'personnelSummary',
    );
  });
});
