import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { SaveAlphaCommand } from '@mje/contracts';
import {
  accountTransaction,
  type AccountAdmission,
  type Actor,
} from './store-kit.js';
import {
  bumpDailyCloseVersion,
  insertDailyCloseDraft,
  insertRevisionEvent,
  insertSubmittedRevision,
  setCurrentRevisionNumber,
} from './report-commands.js';

export interface Identity {
  tenantId: string;
  objectId: string;
}
export class AlphaError extends Error {
  constructor(
    public readonly code:
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'VERSION_CONFLICT'
      | 'IDEMPOTENCY_KEY_REUSED'
      | 'CORRECTION_REASON_REQUIRED',
  ) {
    super(code);
  }
}
const ALPHA_ADMISSION: AccountAdmission = {
  admit: (memberships) =>
    memberships.some((m) => m.role === 'ALPHA_OWNER' && m.projectId !== null),
  forbidden: () => new AlphaError('FORBIDDEN'),
};
export interface ProjectRow {
  id: string;
  name: string;
  code: string;
  timezone: string;
}
export interface RecordRow {
  id: string;
  projectId: string;
  businessDate: string;
  siteTimezone: string;
  version: number;
  currentRevisionNumber: number;
  updatedAt: Date;
  content: unknown;
}

/** Parameterized SQL transactions; schema and additive migrations are maintained by Prisma. */
export class AlphaStore {
  constructor(private readonly pool: Pool) {}

  /** The shared account transaction (ADR-0003 D5); admitted with an active project ALPHA_OWNER role. */
  private transaction<T>(
    identity: Identity,
    work: (client: PoolClient, actor: Actor) => Promise<T>,
  ): Promise<T> {
    return accountTransaction(this.pool, identity, ALPHA_ADMISSION, work);
  }

  private async project(
    client: PoolClient,
    actor: Actor,
    projectId: string,
  ): Promise<ProjectRow> {
    const membership = await client.query(
      `SELECT id FROM "Membership" WHERE "orgId"=$1 AND "accountId"=$2 AND "projectId"=$3
      AND role='ALPHA_OWNER' AND "activeFrom"<=$4::timestamptz AND ("activeUntil" IS NULL OR "activeUntil">$4::timestamptz)`,
      [actor.orgId, actor.accountId, projectId, actor.decidedAt],
    );
    if (!membership.rowCount) throw new AlphaError('FORBIDDEN');
    const result = await client.query<ProjectRow>(
      'SELECT id, name, code, timezone FROM "Project" WHERE "orgId"=$1 AND id=$2',
      [actor.orgId, projectId],
    );
    if (!result.rows[0]) throw new AlphaError('NOT_FOUND');
    // Invalid master-data timezones must not silently become the server timezone.
    new Intl.DateTimeFormat('en', { timeZone: result.rows[0].timezone });
    return result.rows[0];
  }

  async projects(identity: Identity) {
    return this.transaction(identity, async (client, actor) => {
      const result = await client.query<ProjectRow>(
        `SELECT DISTINCT p.id, p.name, p.code, p.timezone FROM "Project" p
        JOIN "Membership" m ON m."orgId"=p."orgId" AND m."projectId"=p.id
        WHERE p."orgId"=$1 AND m."accountId"=$2 AND m.role='ALPHA_OWNER'
          AND m."activeFrom"<=$3::timestamptz AND (m."activeUntil" IS NULL OR m."activeUntil">$3::timestamptz) ORDER BY p.code`,
        [actor.orgId, actor.accountId, actor.decidedAt],
      );
      return {
        accountId: actor.accountId,
        personId: actor.personId,
        projects: result.rows,
      };
    });
  }

  async list(identity: Identity, projectId: string) {
    return this.transaction(identity, async (client, actor) => {
      await this.project(client, actor, projectId);
      const result = await client.query(
        `SELECT d.id, d."businessDate"::text, d.version, d."currentRevisionNumber", d."updatedAt",
        CASE WHEN EXISTS (SELECT 1 FROM "Revision" r WHERE r."orgId"=d."orgId" AND r."dailyCloseId"=d.id AND (r.snapshot->>'aggregateVersion')::integer=d.version) THEN 'SAVED_PENDING_REVIEW' ELSE 'DRAFT' END AS status
        FROM "DailyClose" d JOIN "AlphaDraft" a ON a."orgId"=d."orgId" AND a."dailyCloseId"=d.id
        WHERE d."orgId"=$1 AND d."projectId"=$2 ORDER BY d."businessDate" DESC, d."updatedAt" DESC LIMIT 200`,
        [actor.orgId, projectId],
      );
      return result.rows;
    });
  }

  private async record(
    client: PoolClient,
    actor: Actor,
    recordId: string,
  ): Promise<RecordRow> {
    const result = await client.query<RecordRow>(
      `SELECT d.id, d."projectId", d."businessDate"::text, d."siteTimezone", d.version,
      d."currentRevisionNumber", d."updatedAt", a.content FROM "DailyClose" d
      JOIN "AlphaDraft" a ON a."orgId"=d."orgId" AND a."dailyCloseId"=d.id WHERE d."orgId"=$1 AND d.id=$2`,
      [actor.orgId, recordId],
    );
    if (!result.rows[0]) throw new AlphaError('NOT_FOUND');
    return result.rows[0];
  }

  async get(identity: Identity, recordId: string) {
    return this.transaction(identity, async (client, actor) => {
      const record = await this.record(client, actor, recordId);
      await this.project(client, actor, record.projectId);
      const revisions = await client.query(
        `SELECT id, "revisionNumber", "baseRevisionNumber", reason, "createdAt", snapshot
        FROM "Revision" WHERE "orgId"=$1 AND "dailyCloseId"=$2 ORDER BY "revisionNumber"`,
        [actor.orgId, recordId],
      );
      return { ...record, revisions: revisions.rows };
    });
  }

  async save(identity: Identity, command: SaveAlphaCommand) {
    return this.transaction(identity, async (client, actor) => {
      const project = await this.project(client, actor, command.projectId);
      const route = 'ALPHA_SAVE';
      const requestHash = createHash('sha256')
        .update(JSON.stringify(command))
        .digest('hex');
      // Serialize identical keys even before a row exists; collisions merely serialize unrelated operations.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [
          `${actor.orgId}:${actor.accountId}:${route}:${command.clientMutationId}`,
        ],
      );
      const prior = await client.query<{
        requestHash: string;
        responseBody: unknown;
      }>(
        `SELECT "requestHash", "responseBody" FROM "IdempotencyRecord"
        WHERE "orgId"=$1 AND "actorId"=$2 AND route=$3 AND key=$4`,
        [actor.orgId, actor.accountId, route, command.clientMutationId],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].requestHash !== requestHash)
          throw new AlphaError('IDEMPOTENCY_KEY_REUSED');
        return prior.rows[0].responseBody;
      }
      let baseRevision = 0;
      let siteTimezone = project.timezone;
      let before: unknown = null;
      if (command.expectedVersion === 0) {
        if (command.baseRevisionNumber !== null)
          throw new AlphaError('VERSION_CONFLICT');
        const inserted = await insertDailyCloseDraft(client, {
          id: command.recordId,
          orgId: actor.orgId,
          accountId: actor.accountId,
          businessDate: command.declaration.businessDate,
          siteTimezone,
          scopeKey: `alpha:${command.recordId}`,
          projectId: command.projectId,
          responsiblePersonId: actor.personId,
        });
        if (inserted !== 1) throw new AlphaError('VERSION_CONFLICT');
      } else {
        const existing = await this.record(client, actor, command.recordId);
        if (
          existing.projectId !== command.projectId ||
          existing.businessDate !== command.declaration.businessDate
        )
          throw new AlphaError('VERSION_CONFLICT');
        baseRevision = existing.currentRevisionNumber;
        siteTimezone = existing.siteTimezone;
        before = existing.content;
        const updated = await bumpDailyCloseVersion(
          client,
          actor.orgId,
          command.recordId,
          actor.accountId,
          command.expectedVersion,
        );
        if (updated !== 1) throw new AlphaError('VERSION_CONFLICT');
      }
      if (
        command.action === 'SAVE_VERSION' &&
        baseRevision > 0 &&
        !command.reason.trim()
      )
        throw new AlphaError('CORRECTION_REASON_REQUIRED');
      if (
        (baseRevision === 0 && command.baseRevisionNumber !== null) ||
        (baseRevision > 0 &&
          (command.baseRevisionNumber === null ||
            command.baseRevisionNumber > baseRevision))
      )
        throw new AlphaError('VERSION_CONFLICT');
      const content = {
        sourceBaseRevision: command.baseRevisionNumber,
        sourceKind: 'MANUAL_DECLARATION',
        assignmentStatus: 'PENDING',
        siteTimezone,
        declaration: command.declaration,
      };
      await client.query(
        `INSERT INTO "AlphaDraft"(id,"orgId","dailyCloseId",content,"updatedBy") VALUES($1,$2,$1,$3,$4)
        ON CONFLICT ("orgId","dailyCloseId") DO UPDATE SET content=excluded.content,"updatedAt"=now(),"updatedBy"=excluded."updatedBy"`,
        [command.recordId, actor.orgId, content, actor.accountId],
      );
      const version = command.expectedVersion + 1;
      const revisionNumber =
        baseRevision + (command.action === 'SAVE_VERSION' ? 1 : 0);
      if (command.action === 'SAVE_VERSION') {
        const revisionId = randomUUID();
        await insertSubmittedRevision(client, {
          id: revisionId,
          orgId: actor.orgId,
          accountId: actor.accountId,
          revisionNumber,
          baseRevisionNumber: command.baseRevisionNumber,
          reason: command.reason,
          snapshot: {
            ...content,
            recordId: command.recordId,
            projectId: project.id,
            projectName: project.name,
            projectCode: project.code,
            actorAccountId: actor.accountId,
            actorPersonId: actor.personId,
            aggregateVersion: version,
            status: 'SAVED_PENDING_REVIEW',
          },
          dailyCloseId: command.recordId,
        });
        await insertRevisionEvent(client, {
          id: randomUUID(),
          orgId: actor.orgId,
          accountId: actor.accountId,
          reason: command.reason,
          actorPersonId: actor.personId,
          revisionId,
        });
        await setCurrentRevisionNumber(
          client,
          actor.orgId,
          command.recordId,
          revisionNumber,
        );
      }
      const timestamps = await client.query<{ savedAt: Date }>(
        'SELECT "updatedAt" AS "savedAt" FROM "DailyClose" WHERE "orgId"=$1 AND id=$2',
        [actor.orgId, command.recordId],
      );
      const response = {
        recordId: command.recordId,
        version,
        revisionNumber,
        status:
          command.action === 'SAVE_VERSION' ? 'SAVED_PENDING_REVIEW' : 'DRAFT',
        savedAt: timestamps.rows[0]!.savedAt.toISOString(),
      };
      await client.query(
        `INSERT INTO "AuditLog"(id,"orgId","updatedAt","updatedBy","actorAccountId","actorPersonId","actorKind","entityType","entityId","entityVersion",action,reason,before,after,"correlationId")
        VALUES($1,$2,now(),$3,$3,$4,'HUMAN','ALPHA_DAILY_CLOSE',$5,$6,$7,$8,$9,$10,$11)`,
        [
          randomUUID(),
          actor.orgId,
          actor.accountId,
          actor.personId,
          command.recordId,
          version,
          command.action,
          command.reason,
          before,
          content,
          command.clientMutationId,
        ],
      );
      await client.query(
        `INSERT INTO "IdempotencyRecord"(id,"orgId","updatedAt","updatedBy","actorId",route,key,"requestHash",status,"responseStatus","responseBody")
        VALUES($1,$2,now(),$3,$3,$4,$5,$6,'COMPLETED',200,$7)`,
        [
          randomUUID(),
          actor.orgId,
          actor.accountId,
          route,
          command.clientMutationId,
          requestHash,
          response,
        ],
      );
      return response;
    });
  }
}
