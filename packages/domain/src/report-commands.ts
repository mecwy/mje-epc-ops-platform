/**
 * Report module command exit (ADR-0003 D2.1, A7-0d): the writes to the report day tables
 * (DailyClose, Revision, RevisionEvent) that another module performs inside its own transaction.
 * Each function runs on the caller's PoolClient, so it joins that transaction; the SQL, its
 * parameters and the returned row counts are exactly what the caller used to run inline.
 */
import type { PoolClient } from 'pg';

export interface DailyCloseDraftInsert {
  id: string;
  orgId: string;
  accountId: string;
  businessDate: string;
  siteTimezone: string;
  scopeKey: string;
  projectId: string;
  responsiblePersonId: string;
}

/** A new DRAFT day at version 1; the row count is 0 when the id or scope already exists. */
export async function insertDailyCloseDraft(
  client: PoolClient,
  row: DailyCloseDraftInsert,
): Promise<number | null> {
  const inserted = await client.query(
    `INSERT INTO "DailyClose"
          (id,"orgId","updatedAt","updatedBy",version,"businessDate","siteTimezone","scopeKey",state,"expectedReason","projectId","responsiblePersonId")
          VALUES($1,$2,now(),$3,1,$4,$5,$6,'DRAFT','ALPHA_MANUAL_DECLARATION',$7,$8) ON CONFLICT DO NOTHING`,
    [
      row.id,
      row.orgId,
      row.accountId,
      row.businessDate,
      row.siteTimezone,
      row.scopeKey,
      row.projectId,
      row.responsiblePersonId,
    ],
  );
  return inserted.rowCount;
}

/** Bumps the day version when it is still `expectedVersion`; the row count is 0 on a conflict. */
export async function bumpDailyCloseVersion(
  client: PoolClient,
  orgId: string,
  id: string,
  accountId: string,
  expectedVersion: number,
): Promise<number | null> {
  const updated = await client.query(
    `UPDATE "DailyClose" SET version=version+1,"updatedAt"=now(),"updatedBy"=$3
          WHERE "orgId"=$1 AND id=$2 AND version=$4`,
    [orgId, id, accountId, expectedVersion],
  );
  return updated.rowCount;
}

export interface SubmittedRevisionInsert {
  id: string;
  orgId: string;
  accountId: string;
  revisionNumber: number;
  baseRevisionNumber: number | null;
  reason: string;
  snapshot: unknown;
  dailyCloseId: string;
}

/** An immutable SUBMITTED revision of a day. */
export async function insertSubmittedRevision(
  client: PoolClient,
  row: SubmittedRevisionInsert,
): Promise<void> {
  await client.query(
    `INSERT INTO "Revision"(id,"orgId","updatedAt","updatedBy","revisionNumber","baseRevisionNumber",state,reason,snapshot,"submittedAt","dailyCloseId")
          VALUES($1,$2,now(),$3,$4,$5,'SUBMITTED',$6,$7,now(),$8)`,
    [
      row.id,
      row.orgId,
      row.accountId,
      row.revisionNumber,
      row.baseRevisionNumber,
      row.reason,
      row.snapshot,
      row.dailyCloseId,
    ],
  );
}

export interface RevisionEventInsert {
  id: string;
  orgId: string;
  accountId: string;
  reason: string;
  actorPersonId: string;
  revisionId: string;
}

/** An append-only ALPHA_SAVE_VERSION event of a revision. */
export async function insertRevisionEvent(
  client: PoolClient,
  row: RevisionEventInsert,
): Promise<void> {
  await client.query(
    `INSERT INTO "RevisionEvent"(id,"orgId","updatedAt","updatedBy",action,reason,"actorPersonId","revisionId")
          VALUES($1,$2,now(),$3,'ALPHA_SAVE_VERSION',$4,$5,$6)`,
    [
      row.id,
      row.orgId,
      row.accountId,
      row.reason,
      row.actorPersonId,
      row.revisionId,
    ],
  );
}

/** Points the day at its latest revision number. */
export async function setCurrentRevisionNumber(
  client: PoolClient,
  orgId: string,
  id: string,
  revisionNumber: number,
): Promise<void> {
  await client.query(
    'UPDATE "DailyClose" SET "currentRevisionNumber"=$3 WHERE "orgId"=$1 AND id=$2',
    [orgId, id, revisionNumber],
  );
}
