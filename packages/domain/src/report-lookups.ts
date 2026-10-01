/**
 * Internal report facts for other modules (ADR-0003 D2.1, A7-0e).
 * The caller has already admitted its account or device and supplies its transaction client.
 * These lookups do not apply a public reader projection, acquire locks, or start
 * a transaction. Keep each call at the original statement position in the caller.
 */
import type { PoolClient } from 'pg';
import type { PhotoAsOfDto } from '@mje/contracts';
import { REPORT_SCOPE } from './store-kit.js';

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

export async function reportFrozenPhotos(
  client: PoolClient,
  orgId: string,
  projectId: string,
  businessDate: string,
): Promise<PhotoAsOfDto[]> {
  const r = await client.query<{ photos: PhotoAsOfDto[] | null }>(
    `SELECT r.snapshot->'photos' AS photos FROM "DailyClose" d
    JOIN "Revision" r ON r."orgId"=d."orgId" AND r."dailyCloseId"=d.id AND r."revisionNumber"=d."currentRevisionNumber"
    WHERE d."orgId"=$1 AND d."projectId"=$2 AND d."businessDate"=$3::date AND d."scopeKey"=$4`,
    [orgId, projectId, businessDate, REPORT_SCOPE],
  );
  return r.rows[0]?.photos ?? [];
}

export async function reportPhotoWasFrozen(
  client: PoolClient,
  orgId: string,
  projectId: string,
  photoId: string,
): Promise<boolean> {
  const r = await client.query<{ frozen: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM "Revision" r JOIN "DailyClose" d ON d."orgId"=r."orgId" AND d.id=r."dailyCloseId"
      WHERE r."orgId"=$1 AND d."projectId"=$2 AND d."scopeKey"=$3
        AND r.snapshot->'photos' @> jsonb_build_array(jsonb_build_object('id', $4::text))) AS frozen`,
    [orgId, projectId, REPORT_SCOPE, photoId],
  );
  return r.rows[0]!.frozen;
}

export async function latestReportFrozenPhoto(
  client: PoolClient,
  orgId: string,
  projectId: string,
  photoId: string,
): Promise<PhotoAsOfDto | null> {
  const r = await client.query<{ photo: PhotoAsOfDto }>(
    `SELECT e AS photo FROM "Revision" r JOIN "DailyClose" d ON d."orgId"=r."orgId" AND d.id=r."dailyCloseId"
      CROSS JOIN LATERAL jsonb_array_elements(r.snapshot->'photos') e
      WHERE r."orgId"=$1 AND d."projectId"=$2 AND d."scopeKey"=$3
        AND r.snapshot->'photos' @> jsonb_build_array(jsonb_build_object('id', $4::text))
        AND e->>'id'=$4::text
      ORDER BY d."businessDate" DESC, r."revisionNumber" DESC LIMIT 1`,
    [orgId, projectId, REPORT_SCOPE, photoId],
  );
  return r.rows[0]?.photo ?? null;
}

/** The original upload-state statement, called only after the caller's report-day lock. */
export async function reportUploadDayState(
  client: PoolClient,
  orgId: string,
  projectId: string,
  businessDate: string,
): Promise<{ state: string; correctionReason: string | null } | undefined> {
  const day = await client.query<{
    state: string;
    correctionReason: string | null;
  }>(
    `SELECT state, "correctionReason" FROM "DailyClose"
            WHERE "orgId"=$1 AND "projectId"=$2 AND "businessDate"=$3::date AND "scopeKey"=$4`,
    [orgId, projectId, businessDate, REPORT_SCOPE],
  );
  return day.rows[0];
}

/** Original field boundary: null without submission; zero for a legacy snapshot without field. */
export async function reportSubmittedBoundary(
  client: PoolClient,
  orgId: string,
  projectId: string,
  businessDate: string,
): Promise<number | null> {
  const r = await client.query<{ boundary: string | null }>(
    `SELECT COALESCE(r.snapshot->'field'->>'seqBoundary', '0') AS boundary FROM "DailyClose" d
    JOIN "Revision" r ON r."orgId"=d."orgId" AND r."dailyCloseId"=d.id AND r."revisionNumber"=d."currentRevisionNumber"
    WHERE d."orgId"=$1 AND d."projectId"=$2 AND d."businessDate"=$3::date AND d."scopeKey"='report' AND d."currentRevisionNumber" > 0`,
    [orgId, projectId, businessDate],
  );
  const b = r.rows[0]?.boundary;
  return b === undefined || b === null ? null : Number(b);
}
