/**
 * Internal report facts for other modules (ADR-0003 D2.1, A7-0e).
 * The caller has already admitted its account or device and supplies its transaction client.
 * These master-data lookups do not apply a public reader projection, acquire locks, or start
 * a transaction. Keep each call at the original statement position in the caller.
 */
import type { PoolClient } from 'pg';

/** Whether an active work item belongs to this exact organization and project. */
export async function activeWorkItemExists(
  client: PoolClient,
  orgId: string,
  projectId: string,
  key: string,
): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM "ReportItem" WHERE "orgId"=$1 AND "projectId"=$2 AND kind='work' AND key=$3 AND active`,
    [orgId, projectId, key],
  );
  return !!r.rowCount;
}

/** The active work-item keys used to validate current photo links. */
export async function activeWorkItemKeys(
  client: PoolClient,
  orgId: string,
  projectId: string,
): Promise<Set<string>> {
  const r = await client.query<{ key: string }>(
    `SELECT key FROM "ReportItem" WHERE "orgId"=$1 AND "projectId"=$2 AND kind='work' AND active`,
    [orgId, projectId],
  );
  return new Set(r.rows.map((x) => x.key));
}

/** The foreman's selectable master data, in the existing sort order. */
export async function activeWorkItemCatalog(
  client: PoolClient,
  orgId: string,
  projectId: string,
): Promise<{ key: string; label: string; unit: string }[]> {
  const r = await client.query<{ key: string; label: string; unit: string }>(
    `SELECT key, label, unit FROM "ReportItem" WHERE "orgId"=$1 AND "projectId"=$2 AND kind='work' AND active
      ORDER BY "sortOrder", key`,
    [orgId, projectId],
  );
  return r.rows;
}
