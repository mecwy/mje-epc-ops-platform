import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  DeclareStatusCommand,
  AddStatusNoteCommand,
  StatusCommandResultDto,
  SetPrimaryWorkItemCommand,
  RegisterExpectationCommand,
  PrimaryWorkItemResultDto,
  ReportingExpectationResultDto,
} from '@mje/contracts';
import {
  inTransaction,
  idempotent,
  audit,
  lockProjectForNoKeyUpdate,
  setProjectPrimaryWorkItem,
} from '../store-kit.js';
import type { Identity } from '../alpha-store.js';
import { activeWorkItemExists } from '../report-lookups.js';
import { statusProject, projectStatusReader } from './reader.js';
import { withProjectStatusReadContext } from './context.js';
import { requiredStatusFields, ProjectStatusError } from './rules.js';

export class ProjectStatusCommands {
  constructor(private readonly pool: Pool) {}
  declareStatus(
    identity: Identity,
    c: DeclareStatusCommand,
    correlationId = randomUUID(),
  ) {
    return inTransaction(this.pool, identity, async (client, actor) => {
      const access = await statusProject(client, actor, c.projectId);
      if (access.access !== 'write') throw new ProjectStatusError('READ_ONLY');
      return withProjectStatusReadContext(client, actor, async (ctx) =>
        idempotent<StatusCommandResultDto>(
          client,
          actor,
          'PROJECT_STATUS_DECLARE',
          c.clientMutationId,
          c,
          async () => {
            const fields = requiredStatusFields(c);
            if (fields.length)
              throw new ProjectStatusError('STATUS_FIELDS_REQUIRED', fields);
            const project = await lockProjectForNoKeyUpdate(
              client,
              actor.orgId,
              c.projectId,
            );
            const latest = await client.query<{ n: number }>(
              'SELECT COALESCE(max(n),0)::int AS n FROM "ProjectStatusUpdate" WHERE "orgId"=$1 AND "projectId"=$2',
              [actor.orgId, c.projectId],
            );
            if (latest.rows[0]!.n !== c.expectedN)
              throw new ProjectStatusError('VERSION_CONFLICT');
            const n = c.expectedN + 1,
              id = randomUUID();
            await client.query(
              `INSERT INTO "ProjectStatusUpdate"(id,"orgId","projectId",n,status,areas,situation,recovery,"expectedRecoveryDate","expectedRecoveryUnknown","needsSupport","supportNote","declaredAt","siteTimezone","businessDate","declaredBy","declaredByPersonId")
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12,now(),$13,(now() AT TIME ZONE $13)::date,$14,$15)`,
              [
                id,
                actor.orgId,
                c.projectId,
                n,
                c.status,
                c.areas,
                c.situation,
                c.recovery,
                c.expectedRecoveryDate,
                c.expectedRecoveryUnknown,
                c.needsSupport,
                c.supportNote,
                project.timezone,
                actor.accountId,
                actor.personId,
              ],
            );
            await audit(
              client,
              actor,
              { type: 'PROJECT_STATUS_UPDATE', id, version: n },
              'STATUS_DECLARED',
              '',
              null,
              { ...c, n },
              correlationId,
            );
            return { projectId: c.projectId, n, statusUpdateId: id };
          },
          (value) =>
            projectStatusReader
              .forContext(ctx)
              .acknowledgement(c.projectId, value),
        ),
      );
    });
  }
  addStatusNote(
    identity: Identity,
    c: AddStatusNoteCommand,
    correlationId = randomUUID(),
  ) {
    return inTransaction(this.pool, identity, async (client, actor) => {
      await statusProject(client, actor, c.projectId);
      return withProjectStatusReadContext(client, actor, async (ctx) =>
        idempotent<StatusCommandResultDto>(
          client,
          actor,
          'PROJECT_STATUS_NOTE',
          c.clientMutationId,
          c,
          async () => {
            await lockProjectForNoKeyUpdate(client, actor.orgId, c.projectId);
            const target = await client.query<{ id: string }>(
              'SELECT id FROM "ProjectStatusUpdate" WHERE "orgId"=$1 AND "projectId"=$2 AND n=$3',
              [actor.orgId, c.projectId, c.n],
            );
            if (!target.rows[0]) throw new ProjectStatusError('NOT_FOUND');
            const noteId = randomUUID(),
              statusUpdateId = target.rows[0].id;
            await client.query(
              'INSERT INTO "ProjectStatusNote"(id,"orgId","projectId","statusUpdateId",text,"byAccountId","byPersonId",at) VALUES($1,$2,$3,$4,$5,$6,$7,now())',
              [
                noteId,
                actor.orgId,
                c.projectId,
                statusUpdateId,
                c.text,
                actor.accountId,
                actor.personId,
              ],
            );
            await audit(
              client,
              actor,
              { type: 'PROJECT_STATUS_NOTE', id: noteId, version: 1 },
              'STATUS_NOTE_ADDED',
              '',
              null,
              c,
              correlationId,
            );
            return { projectId: c.projectId, n: c.n, statusUpdateId, noteId };
          },
          (value) =>
            projectStatusReader
              .forContext(ctx)
              .acknowledgement(c.projectId, value),
        ),
      );
    });
  }
  setPrimaryWorkItem(identity: Identity, c: SetPrimaryWorkItemCommand) {
    return inTransaction(this.pool, identity, async (client, actor) => {
      const access = await statusProject(client, actor, c.projectId);
      if (access.access !== 'write') throw new ProjectStatusError('READ_ONLY');
      return withProjectStatusReadContext(client, actor, async (ctx) =>
        idempotent<PrimaryWorkItemResultDto>(
          client,
          actor,
          'PROJECT_SET_PRIMARY',
          c.clientMutationId,
          c,
          async () => {
            const project = await lockProjectForNoKeyUpdate(
              client,
              actor.orgId,
              c.projectId,
            );
            if (project.version !== c.expectedVersion)
              throw new ProjectStatusError('VERSION_CONFLICT');
            if (
              !(await activeWorkItemExists(
                client,
                actor.orgId,
                c.projectId,
                c.key,
              ))
            )
              throw new ProjectStatusError('ITEM_NOT_FOUND');
            const version = await setProjectPrimaryWorkItem(
              client,
              actor.orgId,
              c.projectId,
              actor.accountId,
              c.key,
              c.expectedVersion,
            );
            await audit(
              client,
              actor,
              { type: 'PROJECT_MASTER', id: c.projectId, version },
              'PRIMARY_WORK_ITEM_SET',
              '',
              { key: project.primaryWorkItemKey, version: project.version },
              { ...c, version },
              c.clientMutationId,
            );
            return { projectId: c.projectId, key: c.key, version };
          },
          (value) =>
            projectStatusReader
              .forContext(ctx)
              .primaryAcknowledgement(c.projectId, value),
        ),
      );
    });
  }
  registerExpectation(identity: Identity, c: RegisterExpectationCommand) {
    return inTransaction(this.pool, identity, async (client, actor) => {
      const access = await statusProject(client, actor, c.projectId);
      if (access.access !== 'write') throw new ProjectStatusError('READ_ONLY');
      return withProjectStatusReadContext(client, actor, async (ctx) =>
        idempotent<ReportingExpectationResultDto>(
          client,
          actor,
          'PROJECT_REGISTER_EXPECTATION',
          c.clientMutationId,
          c,
          async () => {
            await lockProjectForNoKeyUpdate(client, actor.orgId, c.projectId);
            const latest = await client.query<{ n: number }>(
              'SELECT COALESCE(max(n),0)::int AS n FROM "ReportingExpectationVersion" WHERE "orgId"=$1 AND "projectId"=$2',
              [actor.orgId, c.projectId],
            );
            const n = latest.rows[0]!.n + 1,
              id = randomUUID();
            const inserted = await client.query<{ registeredAt: Date }>(
              'INSERT INTO "ReportingExpectationVersion"(id,"orgId","projectId",n,"fromDate","toDate",workdays,"registeredAt","registeredBy") VALUES($1,$2,$3,$4,$5::date,$6::date,$7,clock_timestamp(),$8) RETURNING "registeredAt"',
              [
                id,
                actor.orgId,
                c.projectId,
                n,
                c.fromDate,
                c.toDate,
                c.workdays,
                actor.accountId,
              ],
            );
            const registeredAt = inserted.rows[0]!.registeredAt.toISOString();
            await audit(
              client,
              actor,
              { type: 'REPORTING_EXPECTATION', id, version: n },
              'REPORTING_EXPECTATION_REGISTERED',
              '',
              null,
              { ...c, n, registeredAt },
              c.clientMutationId,
            );
            return {
              projectId: c.projectId,
              expectationId: id,
              n,
              registeredAt,
            };
          },
          (value) =>
            projectStatusReader
              .forContext(ctx)
              .expectationAcknowledgement(c.projectId, value),
        ),
      );
    });
  }
}
