/**
 * Internal issue target lookup (ADR-0003 D2.1, A7-0e).
 * Runs on the already-authorized caller's client, inside its existing transaction and at its
 * existing statement position. An issue need not be open to remain a valid photo target.
 */
import type { PoolClient } from 'pg';
import { ISSUE_KIND } from './issue-store.js';

export async function siteIssueExists(
  client: PoolClient,
  orgId: string,
  projectId: string,
  issueId: string,
): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM "Issue" WHERE "orgId"=$1 AND "projectId"=$2 AND id=$3 AND kind=$4`,
    [orgId, projectId, issueId, ISSUE_KIND],
  );
  return !!r.rowCount;
}
