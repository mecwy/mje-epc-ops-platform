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
  /** LoginAccount.authzVersion read under the account lock (ADR-0003 D5). */
  authzVersion: number;
  /**
   * Database decision time (ADR-0003 D5): clock_timestamp() read after the account lock is held,
   * kept as PostgreSQL's timestamptz text (microseconds intact) and passed back as
   * `$n::timestamptz` to every membership predicate of the transaction. Not now(): that is the
   * transaction start, before the lock, and would admit a revocation committed in between.
   */
  decidedAt: string;
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
      | 'FEATURE_DISABLED'
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
      | 'DATE_BEFORE_CREATED'
      | 'DATE_BEFORE_CLOSE'
      | 'DATE_BEFORE_REOPEN'
      // photos (U2.1 rule 8)
      | 'NEEDS_LOCATION'
      | 'UNSUPPORTED_MEDIA'
      | 'PHOTO_TOO_LARGE'
      | 'PHOTO_ELSEWHERE'
      | 'ISSUE_NOT_FOUND'
      | 'NOT_LINKED'
      // foreman adoption (A6c)
      | 'FOREMAN_TOTAL_CHANGED'
      | 'ADOPT_NOT_COMPLETE',
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

/**
 * Serializes writes that depend on whether a report day is open (submission vs. photo upload):
 * both take this transaction lock, so a photo never lands on a day frozen while it was stored.
 */
export async function lockReportDay(
  client: PoolClient,
  orgId: string,
  projectId: string,
  businessDate: string,
) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${orgId}:day:${projectId}:${businessDate}`,
  ]);
}

export const sha = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');

/**
 * ADR-0003 D5 transaction bounds. transaction_timeout is the first statement after BEGIN, so the
 * whole transaction (account lock included) ends within 30 s however it spends the time: many
 * short statements, a lock wait or an idle wait for an external call. The server then
 * terminates the session (25P04; 25P03 for the idle bound) and nothing commits. Verified on
 * PostgreSQL 17.6: SET LOCAL inside the open transaction arms the timer (A7-0b).
 */
export const TRANSACTION_TIMEOUT = '30s';
export const STATEMENT_TIMEOUT = '10s';
export const LOCK_TIMEOUT = '5s';
export const IDLE_IN_TRANSACTION_TIMEOUT = '20s';
/** SQLSTATEs after which repeating the request with the same key is safe (HTTP 503 RETRY). */
export const RETRY_SQLSTATES: readonly string[] = [
  '40P01', // deadlock
  '40001', // serialization failure
  '55P03', // lock_timeout
  '25P04', // transaction_timeout: session terminated, transaction rolled back
  '25P03', // idle_in_transaction_session_timeout: likewise
];
const sqlState = (error: unknown): string | null =>
  error &&
  typeof error === 'object' &&
  'code' in error &&
  typeof error.code === 'string'
    ? error.code
    : null;

/** Rows of app_account_for_identity() plus the database decision time. */
interface AccountRow {
  orgId: string;
  id: string;
  personId: string;
  authzVersion: number;
}
export interface AccountAdmission {
  /** Commands that atomically grant their own account rights must capture FOR UPDATE first. */
  exclusiveAccount?: boolean;
  /** True when the memberships active at decidedAt let the account into this store at all. */
  admit: (memberships: { role: string; projectId: string | null }[]) => boolean;
  forbidden: () => Error;
}
const signals = new WeakMap<PoolClient, AbortSignal>();
/**
 * Aborted when the transaction's connection is lost (e.g. the server ended the session at
 * transaction_timeout) or the transaction ends; external waits inside it (Blob) listen to it.
 */
export function transactionSignal(client: PoolClient): AbortSignal | undefined {
  return signals.get(client);
}

/**
 * Creates a guarded view of this exact client for one awaited read scope. Only a client
 * already registered by the transaction protocol can pass on its lifetime signal; an
 * arbitrary object or prototype copy never gains one. Existing reads without a registered
 * transaction keep their scope guard, but acquire no transaction authority. The child is
 * revoked on either parent abort or scope completion, before a pooled client can be reused.
 */
export async function withTransactionClientScope<T>(
  client: PoolClient,
  use: (guarded: PoolClient) => Promise<T>,
): Promise<T> {
  const parent = signals.get(client);
  const closed = () => new Error('REPORT_READ_CONTEXT_CLOSED');
  if (parent?.aborted) throw closed();
  const controller = new AbortController();
  const guarded = Object.create(client, {
    query: {
      value: (...args: Parameters<PoolClient['query']>) => {
        if (controller.signal.aborted) throw closed();
        return Reflect.apply(client.query, client, args);
      },
    },
  }) as PoolClient;
  const revoke = () => {
    controller.abort(parent?.reason ?? closed());
    signals.delete(guarded);
  };
  if (parent) {
    signals.set(guarded, controller.signal);
    parent.addEventListener('abort', revoke, { once: true });
  }
  try {
    return await use(guarded);
  } finally {
    revoke();
    parent?.removeEventListener('abort', revoke);
  }
}

/**
 * One transaction as the verified account (ADR-0003 D5): BEGIN, the time bounds, the session
 * identity, then the account row through app_account_for_identity() — the first lock, held FOR
 * SHARE until the transaction ends, so a grant or revocation (which updates that row) waits for
 * this transaction, and one committed before it is seen here. Exactly one account row, else
 * forbidden. The memberships are read once, at the database decision time.
 * A client whose connection failed is never returned to the pool, and a request whose session
 * the server ended fails with that SQLSTATE even if its callback is still waiting.
 */
export async function accountTransaction<T>(
  pool: Pool,
  identity: Identity,
  admission: AccountAdmission,
  work: (client: PoolClient, actor: Actor) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const controller = new AbortController();
  let lost: Error | null = null;
  let onLost: (error: Error) => void = () => {};
  const lostPromise = new Promise<never>((_, reject) => {
    onLost = reject;
  });
  lostPromise.catch(() => undefined);
  // node-postgres emits 'error' on a checked-out client when the server ends the session;
  // without a listener that would crash the process. The first error is the classified one
  // (25P04 / 25P03); later ones ("Connection terminated unexpectedly") are not.
  const onError = (error: Error) => {
    if (lost) return;
    lost = error;
    controller.abort(error);
    onLost(error);
  };
  client.on('error', onError);
  signals.set(client, controller.signal);
  try {
    await client.query('BEGIN');
    await client.query(
      `SET LOCAL transaction_timeout = '${TRANSACTION_TIMEOUT}'`,
    );
    await client.query(
      `SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'; SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'; SET LOCAL idle_in_transaction_session_timeout = '${IDLE_IN_TRANSACTION_TIMEOUT}'`,
    );
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.object_id', $2, true)",
      [identity.tenantId, identity.objectId],
    );
    const accounts = await client.query<AccountRow>(
      admission.exclusiveAccount
        ? 'SELECT a."orgId", a.id, a."personId", a."authzVersion" FROM app_account_for_identity_write($1, $2) a'
        : 'SELECT a."orgId", a.id, a."personId", a."authzVersion" FROM app_account_for_identity($1, $2) a',
      [identity.tenantId, identity.objectId],
    );
    if (accounts.rows.length !== 1) throw admission.forbidden();
    const account = accounts.rows[0]!;
    // A separate statement, so the clock is read only after the row lock above is granted: a
    // revocation that committed while this transaction waited for it is in the past.
    const decidedAt = (
      await client.query<{ decidedAt: string }>(
        'SELECT clock_timestamp()::text AS "decidedAt"',
      )
    ).rows[0]!.decidedAt;
    await client.query(
      "SELECT set_config('app.org_id', $1, true), set_config('app.decided_at', $2, true)",
      [account.orgId, decidedAt],
    );
    const memberships = await client.query<{
      role: string;
      projectId: string | null;
    }>(
      `SELECT role, "projectId" FROM "Membership" WHERE "orgId"=$1 AND "accountId"=$2
      AND "activeFrom"<=$3::timestamptz AND ("activeUntil" IS NULL OR "activeUntil">$3::timestamptz)`,
      [account.orgId, account.id, decidedAt],
    );
    if (!admission.admit(memberships.rows)) throw admission.forbidden();
    const actor: Actor = {
      orgId: account.orgId,
      accountId: account.id,
      personId: account.personId,
      authzVersion: account.authzVersion,
      decidedAt,
    };
    const running = work(client, actor);
    running.catch(() => undefined);
    const result = await Promise.race([running, lostPromise]);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (!lost)
      await client.query('ROLLBACK').catch((rollback: Error) => {
        lost ??= rollback;
      });
    // A query on a terminated session fails with a generic "not queryable" error; the server's
    // own termination (25P04 / 25P03) is what the caller must see.
    const terminated: Error | null = lost;
    if (terminated && sqlState(terminated) && !sqlState(error))
      throw terminated;
    throw error;
  } finally {
    controller.abort(new Error('TRANSACTION_ENDED'));
    signals.delete(client);
    client.removeListener('error', onError);
    // A client whose connection failed is destroyed, never reused by another request.
    client.release(lost ?? undefined);
  }
}

/** One report-family transaction: the account must hold at least one active report role. */
export function inTransaction<T>(
  pool: Pool,
  identity: Identity,
  work: (client: PoolClient, actor: Actor) => Promise<T>,
): Promise<T> {
  return accountTransaction(pool, identity, REPORT_ADMISSION, work);
}
const REPORT_ADMISSION: AccountAdmission = {
  // Per-project access is checked later (projectAccess).
  admit: (memberships) =>
    memberships.some((m) =>
      ([...WRITE_ROLES, ...READ_ROLES] as readonly string[]).includes(m.role),
    ),
  forbidden: () => new ReportError('FORBIDDEN'),
};

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
    AND "activeFrom"<=$5::timestamptz AND ("activeUntil" IS NULL OR "activeUntil">$5::timestamptz)`,
    [actor.orgId, actor.accountId, projectId, [...READ_ROLES], actor.decidedAt],
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

/**
 * A response's projection for the caller's current context (ADR-0003 D5 step 4). Applied to the
 * live response and to a replayed one alike, so a replay never returns a stored body as it was
 * projected for an earlier context. Routes whose response has no reader/writer projection (the
 * report command acknowledgements, issue views) pass `asStored`.
 */
export type Projection<T> = (body: T) => T;
export const asStored = <T>(body: T): T => body;

/**
 * Exactly-once per (actor, route, key): replays return the stored response through `project`;
 * a different body is rejected. Callers authorize the resource before calling this, so a
 * revoked caller is refused before any replay lookup.
 */
export async function idempotent<T>(
  client: PoolClient,
  actor: Actor,
  route: string,
  key: string,
  command: unknown,
  work: () => Promise<T>,
  project: Projection<T> = asStored,
  /** Resource-dependent authorization: idem lock → resource lock → reauthorize → replay. */
  beforeReplay?: () => Promise<void>,
): Promise<T> {
  const requestHash = sha(command);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${actor.orgId}:${actor.accountId}:${route}:${key}`,
  ]);
  await beforeReplay?.();
  const prior = await client.query<{ requestHash: string; responseBody: T }>(
    `SELECT "requestHash", "responseBody" FROM "IdempotencyRecord"
    WHERE "orgId"=$1 AND "actorId"=$2 AND route=$3 AND key=$4`,
    [actor.orgId, actor.accountId, route, key],
  );
  if (prior.rows[0]) {
    if (prior.rows[0].requestHash !== requestHash)
      throw new ReportError('IDEMPOTENCY_KEY_REUSED');
    return project(prior.rows[0].responseBody);
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
  return project(response);
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

/**
 * Exclusive, non-key Project capture point. Conflicts with submit's FOR SHARE while remaining
 * compatible with FK KEY SHARE lookups because project key columns are not changed here.
 */
export async function lockProjectForNoKeyUpdate(
  client: PoolClient,
  orgId: string,
  projectId: string,
): Promise<ProjectMasterRow> {
  const r = await client.query<ProjectMasterRow>(
    'SELECT id,name,code,timezone,version,"primaryWorkItemKey",region,"projectType" FROM "Project" WHERE "orgId"=$1 AND id=$2 FOR NO KEY UPDATE',
    [orgId, projectId],
  );
  if (!r.rows[0]) throw new ReportError('NOT_FOUND');
  return r.rows[0];
}

/** Submission captures masters under a shared row lock, before roster/day locks. */
export async function lockProjectForShare(
  client: PoolClient,
  orgId: string,
  projectId: string,
): Promise<ProjectMasterRow> {
  const r = await client.query<ProjectMasterRow>(
    'SELECT id,name,code,timezone,version,"primaryWorkItemKey",region,"projectType" FROM "Project" WHERE "orgId"=$1 AND id=$2 FOR SHARE',
    [orgId, projectId],
  );
  if (!r.rows[0]) throw new ReportError('NOT_FOUND');
  return r.rows[0];
}

export interface ProjectMasterRow extends ReportProjectRow {
  version: number;
  primaryWorkItemKey: string | null;
  region: string | null;
  projectType: string | null;
}
/** Platform-owned write; caller holds the Project row lock and has current PM authority. */
export async function setProjectPrimaryWorkItem(
  client: PoolClient,
  orgId: string,
  projectId: string,
  accountId: string,
  key: string,
  expectedVersion: number,
): Promise<number> {
  const row = await client.query<{ version: number }>(
    'UPDATE "Project" SET "primaryWorkItemKey"=$1,version=version+1,"updatedAt"=now(),"updatedBy"=$2 WHERE "orgId"=$3 AND id=$4 AND version=$5 RETURNING version',
    [key, accountId, orgId, projectId, expectedVersion],
  );
  if (!row.rows[0]) throw new ReportError('VERSION_CONFLICT');
  return row.rows[0].version;
}
