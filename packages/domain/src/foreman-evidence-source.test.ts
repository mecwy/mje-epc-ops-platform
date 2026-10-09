import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { Actor } from './store-kit.js';
import { foremanEvidenceSource } from './foreman-evidence-source.js';
const actor: Actor = {
  orgId: 'TEST_org',
  accountId: 'TEST_account',
  personId: 'TEST_person',
  authzVersion: 1,
  decidedAt: '2026-10-08T00:00:00Z',
};
const target = {
  projectId: 'TEST_project',
  businessDate: '2026-10-06',
  crewId: 'TEST_crew',
  foremanRevisionId: 'TEST_revision1',
  itemKey: 'TEST_WORK',
};
const revision = {
  id: target.foremanRevisionId,
  reportId: 'TEST_report',
  n: 1,
  rows: [{ itemKey: target.itemKey, qty: '10.000000' }],
  byPersonId: 'TEST_foreman',
  siteTimezone: 'Europe/Belgrade',
  crewLabel: 'TEST crew',
};
function db(row: unknown = revision, currentN = 2) {
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: row ? [row] : [] })
    .mockResolvedValueOnce({ rows: [{ currentN }] });
  return { client: { query } as unknown as PoolClient, query };
}
describe('immutable foreman evidence source', () => {
  it('keeps old source quantity and unknown historical context separate from a corrected head', async () => {
    const { client, query } = db();
    const result = await foremanEvidenceSource(client, actor, target);
    expect(result).toMatchObject({
      currentRevisionNumber: 2,
      declaration: {
        revisionNumber: 1,
        qty: '10.000000',
        unit: null,
        scopeRef: null,
        scopeStatus: 'PENDING',
        reportedIdentityResolved: false,
      },
    });
    expect(query.mock.calls[0]?.[1]).toEqual([
      actor.orgId,
      target.projectId,
      target.businessDate,
      target.crewId,
      target.foremanRevisionId,
    ]);
    expect(query.mock.calls[1]?.[1]).toEqual([
      actor.orgId,
      target.projectId,
      'TEST_report',
      target.crewId,
      target.businessDate,
    ]);
    expect(
      query.mock.calls.every(([sql]) => !String(sql).includes('ReportItem')),
    ).toBe(true);
  });
  it('does not replace a missing source with current report quantities', async () => {
    const { client, query } = db(null);
    expect(await foremanEvidenceSource(client, actor, target)).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('rejects an inconsistent head instead of enabling binding to a future revision', async () => {
    await expect(
      foremanEvidenceSource(db(revision, 0).client, actor, target),
    ).rejects.toThrow('SOURCE_UNAVAILABLE');
  });
});
