/**
 * Shared server-side plumbing of the Site Daily Close stores (report, issues): the tenant
 * transaction, per-project access, exactly-once idempotency and the append-only audit.
 * Moved verbatim out of ReportStore so that every store enforces the same rules.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Identity } from './alpha-store.js';

export interface Actor {
  orgId: string;
  accountId: string;
  personId: string;
}
export type Access = 'write' | 'read';
/** DailyClose.scopeKey of a Site Daily Close report day. */
export const REPORT_SCOPE = 'report';
export const WRITE_ROLES = ['PROJECT_MANAGER'] as const;
export const READ_ROLES = ['EXECUTIVE_READER'] as const;

export class ReportError extends Error {
  constructor(
    public readonly code:
      | 'FORBIDDEN'
      | 'READ_ONLY'
      | 'NOT_FOUND'
      | 'VERSION_CONFLICT'
      | 'IDEMPOTENCY_KEY_REUSED'
      | 'LOCKED'
      | 'NOT_SUBMITTED'
      | 'NOT_CORRECTING'
      | 'NUMBER_INVALID'
      | 'PLAN_NO_CHANGE'
      | 'PLAN_EMPTY'
      // issues (U2.1 rule 10)
      | 'CATEGORY_REQUIRED'
      | 'NEEDS_EXPERT'
      | 'ITEM_NOT_FOUND'
      | 'OWNER_NOT_FOUND'
      | 'ISSUE_CLOSED'
      | 'ISSUE_NOT_CLOSED'
      | 'DATE_BEFORE_CREATED',
  ) {
    super(code);
  }
}
export interface ReportProjectRow {
  id: string;
  name: string;
  code: string;
  timezone: string;
}

export const sha = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** One transaction as the verified account, with the org fixed for RLS. */
export async function inTransaction<T>(
  pool: Pool,
  identity: Identity,
  work: (client: PoolClient, actor: Actor) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.object_id', $2, true)",
      [identity.tenantId, identity.objectId],
    );
    // The account must hold at least one active report role; per-project access is checked later.
    const accounts = await client.query<Actor>(
      `SELECT a."orgId", a.id AS "accountId", a."personId"
      FROM "LoginAccount" a WHERE a.active AND a."entraTenantId"=$1 AND a."entraObjectId"=$2 AND a."personId" IS NOT NULL
      AND EXISTS (SELECT 1 FROM "Membership" m WHERE m."orgId"=a."orgId" AND m."accountId"=a.id
        AND m.role = ANY($3::text[]) AND m."activeFrom"<=now() AND (m."activeUntil" IS NULL OR m."activeUntil">now()))`,
      [identity.tenantId, identity.objectId, [...WRITE_ROLES, ...READ_ROLES]],
    );
    if (accounts.rows.length !== 1) throw new ReportError('FORBIDDEN');
    const actor = accounts.rows[0]!;
    await client.query("SELECT set_config('app.org_id', $1, true)", [
      actor.orgId,
    ]);
    const result = await work(client, actor);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Access to one project: PROJECT_MANAGER writes; EXECUTIVE_READER (per project or org-wide) reads. */
export async function projectAccess(
  client: PoolClient,
  actor: Actor,
  projectId: string,
): Promise<{ project: ReportProjectRow; access: Access }> {
  const roles = await client.query<{
    role: string;
    projectId: string | null;
  }>(
    `SELECT role, "projectId" FROM "Membership" WHERE "orgId"=$1 AND "accountId"=$2
    AND ("projectId"=$3 OR ("projectId" IS NULL AND role = ANY($4::text[])))
    AND "activeFrom"<=now() AND ("activeUntil" IS NULL OR "activeUntil">now())`,
    [actor.orgId, actor.accountId, projectId, [...READ_ROLES]],
  );
  const access: Access | null = roles.rows.some((r) =>
    (WRITE_ROLES as readonly string[]).includes(r.role),
  )
    ? 'write'
    : roles.rows.some((r) => (READ_ROLES as readonly string[]).includes(r.role))
      ? 'read'
      : null;
  if (!access) throw new ReportError('FORBIDDEN');
  const result = await client.query<ReportProjectRow>(
    'SELECT id, name, code, timezone FROM "Project" WHERE "orgId"=$1 AND id=$2',
    [actor.orgId, projectId],
  );
  if (!result.rows[0]) throw new ReportError('NOT_FOUND');
  // Invalid master-data timezones must not silently become the server timezone.
  new Intl.DateTimeFormat('en', { timeZone: result.rows[0].timezone });
  return { project: result.rows[0], access };
}
export async function projectWriter(
  client: PoolClient,
  actor: Actor,
  projectId: string,
): Promise<ReportProjectRow> {
  const a = await projectAccess(client, actor, projectId);
  if (a.access !== 'write') throw new ReportError('READ_ONLY');
  return a.project;
}

/** Exactly-once per (actor, route, key): replays return the stored response; a different body is rejected. */
export async function idempotent<T>(
  client: PoolClient,
  actor: Actor,
  route: string,
  key: string,
  command: unknown,
  work: () => Promise<T>,
): Promise<T> {
  const requestHash = sha(command);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${actor.orgId}:${actor.accountId}:${route}:${key}`,
  ]);
  const prior = await client.query<{ requestHash: string; responseBody: T }>(
    `SELECT "requestHash", "responseBody" FROM "IdempotencyRecord"
    WHERE "orgId"=$1 AND "actorId"=$2 AND route=$3 AND key=$4`,
    [actor.orgId, actor.accountId, route, key],
  );
  if (prior.rows[0]) {
    if (prior.rows[0].requestHash !== requestHash)
      throw new ReportError('IDEMPOTENCY_KEY_REUSED');
    return prior.rows[0].responseBody;
  }
  const response = await work();
  await client.query(
    `INSERT INTO "IdempotencyRecord"(id,"orgId","updatedAt","updatedBy","actorId",route,key,"requestHash",status,"responseStatus","responseBody")
    VALUES($1,$2,now(),$3,$3,$4,$5,$6,'COMPLETED',200,$7)`,
    [
      randomUUID(),
      actor.orgId,
      actor.accountId,
      route,
      key,
      requestHash,
      response,
    ],
  );
  return response;
}

export async function audit(
  client: PoolClient,
  actor: Actor,
  entity: { type: string; id: string; version: number },
  action: string,
  reason: string,
  before: unknown,
  after: unknown,
  correlationId: string,
) {
  await client.query(
    `INSERT INTO "AuditLog"(id,"orgId","updatedAt","updatedBy","actorAccountId","actorPersonId","actorKind","entityType","entityId","entityVersion",action,reason,before,after,"correlationId")
    VALUES($1,$2,now(),$3,$3,$4,'HUMAN',$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      randomUUID(),
      actor.orgId,
      actor.accountId,
      actor.personId,
      entity.type,
      entity.id,
      entity.version,
      action,
      reason,
      // pg would send a JS array as a Postgres array, not JSON; serialize explicitly.
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      correlationId,
    ],
  );
}
