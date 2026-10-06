import { randomUUID } from 'node:crypto';
import { InvalidReportInput } from '@mje/contracts';
import type { Pool, PoolClient } from 'pg';
import type {
  CancelCorrectionCommand,
  ConfirmPlanCommand,
  DayFactsDto,
  ForemanAdoptCommand,
  ForemanAdoptResultDto,
  NoWorkCommand,
  PlanRowDto,
  ReportItemDto,
  FrozenMilestoneDto,
  SaveFactsCommand,
  SaveItemsCommand,
  SavePlanDraftCommand,
  StartCorrectionCommand,
  SubmitReportCommand,
} from '@mje/contracts';
import {
  blankFacts,
  confirmPlan,
  coverage,
  dec,
  decText,
  hasFacts,
  planRows,
  planStatus,
  sameForemanBasis,
  shiftDate,
  carryCumulative,
  carryMaterial,
  type CarriedCumulative,
  type Coverage,
  type DayFacts,
  type MaterialCumulative,
  type PlanState,
  type PlanVersion,
} from './report-rules.js';

const planLock = (orgId: string, projectId: string, target: string) =>
  `${orgId}:plan:${projectId}:${target}`;

/**
 * Site Daily Close store (U2.1 rules 1–7, 12–14). One DailyClose row per project and business
 * day (scopeKey REPORT_SCOPE). Facts live in DailyReportDraft until submission freezes them into
 * a Revision snapshot; a correction is a new revision with a reason and the earlier one stays.
 * Plans are confirmed versions per target day; the baseline of a day is its latest version.
 * Everything here is a declaration by the reporter, not a verified site fact.
 * A read-only account only ever gets submitted revisions and confirmed plans (OD18, reader-view),
 * and never a photo's coordinates (OD20).
 */
import type { Identity } from './alpha-store.js';
import {
  READ_ROLES,
  REPORT_SCOPE,
  ReportError,
  WRITE_ROLES,
  audit,
  idempotent,
  inTransaction,
  lockReportDay,
  lockProjectForNoKeyUpdate,
  lockProjectForShare,
  projectWriter,
  type Actor,
  type ReportProjectRow,
  type ProjectMasterRow,
} from './store-kit.js';
import { issuesAsOf } from './issue-store.js';
import { fieldDayAsOf, nextSeq } from './checkin-store.js';
import { FieldError, rosterLock } from './field-kit.js';
import { foremanDayAsOf, recordForemanAdoption } from './foreman-store.js';
import {
  photoAsOf,
  photographedItems,
  photosOfDay,
  submittedPhotos,
} from './photo-store.js';
import {
  withReportReadContext,
  type ReportReadContext,
} from './report-read-context.js';

export {
  READ_ROLES,
  REPORT_SCOPE,
  ReportError,
  WRITE_ROLES,
  type ReportProjectRow,
};
type ProjectRow = ReportProjectRow;
export interface DayRow {
  id: string;
  version: number;
  state: string;
  currentRevisionNumber: number;
  correctionReason: string | null;
  siteTimezone: string;
  updatedAt: Date;
}
export interface RevisionRow {
  revisionNumber: number;
  reason: string;
  submittedAt: Date;
  updatedBy: string;
  snapshot: Record<string, unknown>;
}
interface PlanVersionRow {
  number: number;
  rows: PlanRowDto[];
  confirmedAt: Date;
  confirmedBy: string;
}
export interface ItemRow extends ReportItemDto {
  id: string;
}
export const publicItem = (r: ItemRow): ReportItemDto => ({
  kind: r.kind,
  key: r.key,
  label: r.label,
  unit: r.unit,
  designQty: r.designQty,
  openingCumulative: r.openingCumulative,
  sortOrder: r.sortOrder,
  active: r.active,
  ...(r.plannedDate == null ? {} : { plannedDate: r.plannedDate }),
});
export type DayState = 'empty' | 'draft' | 'submitted' | 'correcting';

export class ReportStore {
  constructor(private readonly pool: Pool) {}

  private transaction<T>(
    identity: Identity,
    work: (client: PoolClient, actor: Actor) => Promise<T>,
  ): Promise<T> {
    return inTransaction(this.pool, identity, work);
  }
  /**
   * Every report read (ADR-0003 D2): one transaction as the verified account, whose context is
   * handed to the report module exit (`reportReader.forContext(ctx)`); the exit checks the
   * project and applies the projection. The store itself serves no read route.
   */
  read<T>(
    identity: Identity,
    use: (ctx: ReportReadContext) => Promise<T>,
  ): Promise<T> {
    return this.transaction(identity, (client, actor) =>
      withReportReadContext(client, actor, use),
    );
  }
  private writer(client: PoolClient, actor: Actor, projectId: string) {
    return projectWriter(client, actor, projectId);
  }
  private idempotent<T>(
    client: PoolClient,
    actor: Actor,
    route: string,
    key: string,
    command: unknown,
    work: () => Promise<T>,
  ): Promise<T> {
    return idempotent(client, actor, route, key, command, work);
  }
  private audit(...args: Parameters<typeof audit>) {
    return audit(...args);
  }

  /** Creates the day row (expectedVersion 0) or bumps its version (expectedVersion = current). */
  private async dayForWrite(
    client: PoolClient,
    actor: Actor,
    project: ProjectRow,
    businessDate: string,
    expectedVersion: number,
  ): Promise<DayRow> {
    if (expectedVersion === 0) {
      const id = randomUUID();
      const inserted = await client.query(
        `INSERT INTO "DailyClose"
        (id,"orgId","updatedAt","updatedBy",version,"businessDate","siteTimezone","scopeKey",state,"expectedReason","projectId","responsiblePersonId")
        VALUES($1,$2,now(),$3,1,$4::date,$5,$6,'DRAFT','SITE_DAILY_CLOSE',$7,$8) ON CONFLICT DO NOTHING`,
        [
          id,
          actor.orgId,
          actor.accountId,
          businessDate,
          project.timezone,
          REPORT_SCOPE,
          project.id,
          actor.personId,
        ],
      );
      if (inserted.rowCount !== 1) throw new ReportError('VERSION_CONFLICT');
      return (await dayRow(
        client,
        actor.orgId,
        project.id,
        businessDate,
        true,
      ))!;
    }
    const existing = await dayRow(
      client,
      actor.orgId,
      project.id,
      businessDate,
      true,
    );
    if (!existing) throw new ReportError('VERSION_CONFLICT');
    const updated = await client.query(
      `UPDATE "DailyClose" SET version=version+1,"updatedAt"=now(),"updatedBy"=$3
      WHERE "orgId"=$1 AND id=$2 AND version=$4`,
      [actor.orgId, existing.id, actor.accountId, expectedVersion],
    );
    if (updated.rowCount !== 1) throw new ReportError('VERSION_CONFLICT');
    return { ...existing, version: expectedVersion + 1 };
  }
  private async saveDraft(
    client: PoolClient,
    actor: Actor,
    dailyCloseId: string,
    facts: DayFacts,
  ) {
    await client.query(
      `INSERT INTO "DailyReportDraft"(id,"orgId","dailyCloseId",facts,"updatedBy") VALUES($1,$2,$3,$4,$5)
      ON CONFLICT ("orgId","dailyCloseId") DO UPDATE SET facts=excluded.facts,"updatedAt"=now(),"updatedBy"=excluded."updatedBy"`,
      [randomUUID(), actor.orgId, dailyCloseId, facts, actor.accountId],
    );
  }

  // ---------- writes ----------
  /** Rule 1: a submitted day only accepts facts while a correction is open. */
  async saveFacts(identity: Identity, command: SaveFactsCommand) {
    return this.transaction(identity, async (client, actor) => {
      const project = await this.writer(client, actor, command.projectId);
      return this.idempotent(
        client,
        actor,
        'REPORT_SAVE_FACTS',
        command.clientMutationId,
        command,
        async () => {
          const day = await this.dayForWrite(
            client,
            actor,
            project,
            command.businessDate,
            command.expectedVersion,
          );
          if (day.state === 'SUBMITTED' && day.correctionReason === null)
            throw new ReportError('LOCKED');
          const before = await draftFacts(client, actor.orgId, day.id);
          // Omission by an older client cannot erase source cells already on the locked draft.
          const facts = {
            ...command.facts,
            ...(!Object.hasOwn(command.facts, 'sourceReport') &&
            before?.sourceReport
              ? { sourceReport: before.sourceReport }
              : {}),
          };
          if (command.facts.sourceReport) {
            const items = await itemRows(client, actor.orgId, project.id);
            const source = command.facts.sourceReport;
            if (
              before?.sourceReport &&
              source.schemaVersion < before.sourceReport.schemaVersion
            )
              throw new InvalidReportInput('facts.sourceReport.schemaVersion');
            // Explicit source replacement cannot silently lose an already stored extension.
            for (const extension of [
              'reportedNextPlan',
              'milestones',
              'machinery',
              'personnelRemarks',
              'reportedRecorder',
            ] as const) {
              if (
                before?.sourceReport &&
                Object.hasOwn(before.sourceReport, extension) &&
                !Object.hasOwn(source, extension)
              )
                throw new InvalidReportInput(`facts.sourceReport.${extension}`);
            }
            if (
              source.schemaVersion !== 1 &&
              source.reportedNextPlan &&
              source.reportedNextPlan.targetBusinessDate !==
                shiftDate(command.businessDate, 1)
            )
              throw new InvalidReportInput(
                'facts.sourceReport.reportedNextPlan.targetBusinessDate',
              );
            for (const [kind, keys] of [
              [
                'work',
                [
                  ...Object.keys(source.workPercent),
                  ...(source.schemaVersion !== 1 && source.reportedNextPlan
                    ? Object.keys(source.reportedNextPlan.quantities)
                    : []),
                ],
              ],
              ['material', Object.keys(source.materials)],
              [
                'machinery',
                source.schemaVersion === 4
                  ? Object.keys(source.machinery ?? {})
                  : [],
              ],
              [
                'milestone',
                'milestones' in source && source.milestones
                  ? Object.keys(source.milestones)
                  : [],
              ],
            ] as const) {
              if (
                keys.some(
                  (key) =>
                    !items.some(
                      (item) => item.kind === kind && item.key === key,
                    ),
                )
              )
                throw new InvalidReportInput('facts.sourceReport.items');
            }
          }
          await this.saveDraft(client, actor, day.id, facts);
          await this.audit(
            client,
            actor,
            { type: 'SITE_DAILY_CLOSE', id: day.id, version: day.version },
            'REPORT_SAVE_FACTS',
            '',
            before,
            facts,
            command.clientMutationId,
          );
          return {
            businessDate: command.businessDate,
            version: day.version,
            state: dayState(day, facts),
          };
        },
      );
    });
  }

  private async submitRevision(
    client: PoolClient,
    actor: Actor,
    project: ProjectMasterRow,
    day: DayRow,
    businessDate: string,
    facts: DayFacts,
    action: 'REPORT_SUBMIT' | 'REPORT_NO_WORK',
    correlationId: string,
  ) {
    if (day.state === 'SUBMITTED' && day.correctionReason === null)
      throw new ReportError('LOCKED');
    // A photo upload for this day either lands before the snapshot or finds the day locked.
    await lockReportDay(client, actor.orgId, project.id, businessDate);
    // Design §5 submission boundary: the field rows numbered up to the day's sequence as read
    // under the day lock (never by receipt time); later rows are afterSubmission.
    const field = await fieldDayAsOf(
      client,
      actor.orgId,
      project.id,
      businessDate,
    );
    const items = await itemRows(client, actor.orgId, project.id);
    const { snapshot, coverage: cov } = await daySnapshot(
      client,
      actor,
      project,
      businessDate,
      facts,
      items,
    );
    // Rule 5: missing items never block; numbers that are not valid do.
    if (cov.invalid.length) throw new ReportError('NUMBER_INVALID');
    const reason = day.correctionReason ?? '';
    const revisionNumber = day.currentRevisionNumber + 1;
    const revisionId = randomUUID();
    await client.query(
      `INSERT INTO "Revision"(id,"orgId","updatedAt","updatedBy","revisionNumber","baseRevisionNumber",state,reason,snapshot,"submittedAt","dailyCloseId")
      VALUES($1,$2,now(),$3,$4,$5,'SUBMITTED',$6,$7,now(),$8)`,
      [
        revisionId,
        actor.orgId,
        actor.accountId,
        revisionNumber,
        day.currentRevisionNumber || null,
        reason,
        {
          ...snapshot,
          primaryWorkItemKey: project.primaryWorkItemKey,
          milestones: items
            .filter((i) => i.kind === 'milestone')
            .map((i) => ({
              id: i.id,
              key: i.key,
              label: i.label,
              plannedDate: i.plannedDate ?? null,
            })) satisfies FrozenMilestoneDto[],
          // C20 applies to the stored revision, not the writer's live plan preview.
          nextPlan: {
            ...snapshot.nextPlan,
            rows:
              snapshot.nextPlan.status === 'confirmed'
                ? snapshot.nextPlan.rows
                : [],
          },
          field,
          revisionNumber,
          correctionReason: reason,
          aggregateVersion: day.version,
        },
        day.id,
      ],
    );
    await client.query(
      `INSERT INTO "RevisionEvent"(id,"orgId","updatedAt","updatedBy",action,reason,"actorPersonId","revisionId")
      VALUES($1,$2,now(),$3,$4,$5,$6,$7)`,
      [
        randomUUID(),
        actor.orgId,
        actor.accountId,
        action,
        reason,
        actor.personId,
        revisionId,
      ],
    );
    await client.query(
      `UPDATE "DailyClose" SET state='SUBMITTED',"currentRevisionNumber"=$3,"correctionReason"=NULL WHERE "orgId"=$1 AND id=$2`,
      [actor.orgId, day.id, revisionNumber],
    );
    await this.audit(
      client,
      actor,
      { type: 'SITE_DAILY_CLOSE', id: day.id, version: day.version },
      action,
      reason,
      {
        revisionNumber: day.currentRevisionNumber,
        correctionReason: day.correctionReason,
      },
      { revisionNumber, coverage: cov },
      correlationId,
    );
    return {
      businessDate,
      version: day.version,
      state: 'submitted' as DayState,
      revisionNumber,
      coverage: cov,
    };
  }

  /** Rule 1 and 5: submit freezes the current facts; coverage is recorded, not enforced. */
  async submit(identity: Identity, command: SubmitReportCommand) {
    return this.transaction(identity, async (client, actor) => {
      await this.writer(client, actor, command.projectId);
      return this.idempotent(
        client,
        actor,
        'REPORT_SUBMIT',
        command.clientMutationId,
        command,
        async () => {
          // Account/scope -> idempotency -> Project SHARE -> roster -> DailyClose/day.
          const project = await lockProjectForShare(
            client,
            actor.orgId,
            command.projectId,
          );
          // Level 0 shared before the DailyClose row (level 3), never after (design §5).
          await rosterLock(client, actor.orgId, project.id, true);
          const day = await this.dayForWrite(
            client,
            actor,
            project,
            command.businessDate,
            command.expectedVersion,
          );
          const facts =
            (await draftFacts(client, actor.orgId, day.id)) ?? blankFacts();
          if (!(await draftFacts(client, actor.orgId, day.id)))
            await this.saveDraft(client, actor, day.id, facts);
          return this.submitRevision(
            client,
            actor,
            project,
            day,
            command.businessDate,
            facts,
            'REPORT_SUBMIT',
            command.clientMutationId,
          );
        },
      );
    });
  }

  /** Rule 6: no work today = reason (+ note) and an immediate submission. */
  async noWork(identity: Identity, command: NoWorkCommand) {
    return this.transaction(identity, async (client, actor) => {
      await this.writer(client, actor, command.projectId);
      return this.idempotent(
        client,
        actor,
        'REPORT_NO_WORK',
        command.clientMutationId,
        command,
        async () => {
          // Account/scope -> idempotency -> Project SHARE -> roster -> DailyClose/day.
          const project = await lockProjectForShare(
            client,
            actor.orgId,
            command.projectId,
          );
          // Level 0 shared before the DailyClose row (level 3), never after (design §5).
          await rosterLock(client, actor.orgId, project.id, true);
          const day = await this.dayForWrite(
            client,
            actor,
            project,
            command.businessDate,
            command.expectedVersion,
          );
          if (day.state === 'SUBMITTED' && day.correctionReason === null)
            throw new ReportError('LOCKED');
          const facts: DayFacts = {
            ...((await draftFacts(client, actor.orgId, day.id)) ??
              blankFacts()),
            noWork: { reason: command.reason, note: command.note },
          };
          await this.saveDraft(client, actor, day.id, facts);
          return this.submitRevision(
            client,
            actor,
            project,
            day,
            command.businessDate,
            facts,
            'REPORT_NO_WORK',
            command.clientMutationId,
          );
        },
      );
    });
  }

  /**
   * Design §4: the PM adopts a COMPLETE foreman total as the day's quantity, explicitly and
   * against the exact basis it saw. Under the lock order (roster shared → DailyClose → day lock)
   * the roster version, the expected crew set and the latest revisions are recomputed: any
   * difference → FOREMAN_TOTAL_CHANGED; a total that is not COMPLETE → ADOPT_NOT_COMPLETE; a
   * locked day → LOCKED unless a correction is open. Nothing is adopted automatically.
   */
  async adoptForeman(
    identity: Identity,
    command: ForemanAdoptCommand,
  ): Promise<ForemanAdoptResultDto> {
    return this.transaction(identity, async (client, actor) => {
      const project = await this.writer(client, actor, command.projectId);
      return this.idempotent(
        client,
        actor,
        'REPORT_FOREMAN_ADOPT',
        command.clientMutationId,
        command,
        async () => {
          await rosterLock(client, actor.orgId, project.id, true);
          const day = await this.dayForWrite(
            client,
            actor,
            project,
            command.businessDate,
            command.expectedVersion,
          );
          await lockReportDay(
            client,
            actor.orgId,
            project.id,
            command.businessDate,
          );
          const items = await itemRows(client, actor.orgId, project.id);
          const work = activeKeys(items, 'work');
          if (!work.includes(command.item))
            throw new FieldError('ITEM_NOT_FOUND');
          const view = await foremanDayAsOf(
            client,
            actor.orgId,
            project.id,
            command.businessDate,
            project.timezone,
            work,
          );
          if (!sameForemanBasis(command.basis, view.basis))
            throw new ReportError('FOREMAN_TOTAL_CHANGED');
          const total = view.items[command.item];
          if (total?.status !== 'COMPLETE' || total.value === null)
            throw new ReportError('ADOPT_NOT_COMPLETE');
          if (day.state === 'SUBMITTED' && day.correctionReason === null)
            throw new ReportError('LOCKED');
          const before =
            (await draftFacts(client, actor.orgId, day.id)) ?? blankFacts();
          const facts: DayFacts = {
            ...before,
            qty: { ...before.qty, [command.item]: total.value },
          };
          await this.saveDraft(client, actor, day.id, facts);
          const daySeq = await nextSeq(
            client,
            actor.orgId,
            project.id,
            command.businessDate,
          );
          const adoptionId = randomUUID();
          await recordForemanAdoption(client, {
            id: adoptionId,
            orgId: actor.orgId,
            projectId: project.id,
            businessDate: command.businessDate,
            itemKey: command.item,
            value: total.value,
            basis: JSON.stringify(view.basis),
            daySeq,
            byAccountId: actor.accountId,
          });
          await this.audit(
            client,
            actor,
            { type: 'SITE_DAILY_CLOSE', id: day.id, version: day.version },
            'REPORT_FOREMAN_ADOPT',
            '',
            { item: command.item, qty: before.qty[command.item] ?? '' },
            {
              item: command.item,
              qty: total.value,
              adoptionId,
              basis: view.basis,
            },
            command.clientMutationId,
          );
          return {
            businessDate: command.businessDate,
            version: day.version,
            item: command.item,
            value: total.value,
            adoptionId,
          };
        },
      );
    });
  }

  /** Rule 2: a correction needs a reason and only applies to a submitted day. */
  async startCorrection(identity: Identity, command: StartCorrectionCommand) {
    return this.transaction(identity, async (client, actor) => {
      const project = await this.writer(client, actor, command.projectId);
      return this.idempotent(
        client,
        actor,
        'REPORT_CORRECTION_START',
        command.clientMutationId,
        command,
        async () => {
          const day = await dayRow(
            client,
            actor.orgId,
            project.id,
            command.businessDate,
            true,
          );
          if (!day || day.state !== 'SUBMITTED')
            throw new ReportError('NOT_SUBMITTED');
          if (day.version !== command.expectedVersion)
            throw new ReportError('VERSION_CONFLICT');
          if (day.correctionReason !== null) throw new ReportError('LOCKED');
          await client.query(
            `UPDATE "DailyClose" SET "correctionReason"=$3, version=version+1, "updatedAt"=now(), "updatedBy"=$4 WHERE "orgId"=$1 AND id=$2`,
            [actor.orgId, day.id, command.reason, actor.accountId],
          );
          await this.audit(
            client,
            actor,
            { type: 'SITE_DAILY_CLOSE', id: day.id, version: day.version + 1 },
            'REPORT_CORRECTION_START',
            command.reason,
            null,
            null,
            command.clientMutationId,
          );
          return {
            businessDate: command.businessDate,
            version: day.version + 1,
            state: 'correcting' as DayState,
          };
        },
      );
    });
  }

  /** Cancelling restores the draft to the last submitted snapshot; nothing edited survives. */
  async cancelCorrection(identity: Identity, command: CancelCorrectionCommand) {
    return this.transaction(identity, async (client, actor) => {
      const project = await this.writer(client, actor, command.projectId);
      return this.idempotent(
        client,
        actor,
        'REPORT_CORRECTION_CANCEL',
        command.clientMutationId,
        command,
        async () => {
          const day = await dayRow(
            client,
            actor.orgId,
            project.id,
            command.businessDate,
            true,
          );
          if (
            !day ||
            day.state !== 'SUBMITTED' ||
            day.correctionReason === null
          )
            throw new ReportError('NOT_CORRECTING');
          // A stale cancel must not discard edits of a newer correction.
          if (day.version !== command.expectedVersion)
            throw new ReportError('VERSION_CONFLICT');
          const current = (
            await revisionRows(client, actor.orgId, day.id)
          ).find((r) => r.revisionNumber === day.currentRevisionNumber);
          if (!current) throw new ReportError('NOT_FOUND');
          await this.saveDraft(
            client,
            actor,
            day.id,
            current.snapshot['facts'] as DayFactsDto,
          );
          await client.query(
            `UPDATE "DailyClose" SET "correctionReason"=NULL, version=version+1, "updatedAt"=now(), "updatedBy"=$3 WHERE "orgId"=$1 AND id=$2`,
            [actor.orgId, day.id, actor.accountId],
          );
          await this.audit(
            client,
            actor,
            { type: 'SITE_DAILY_CLOSE', id: day.id, version: day.version + 1 },
            'REPORT_CORRECTION_CANCEL',
            day.correctionReason,
            null,
            null,
            command.clientMutationId,
          );
          return {
            businessDate: command.businessDate,
            version: day.version + 1,
            state: 'submitted' as DayState,
          };
        },
      );
    });
  }

  async savePlanDraft(identity: Identity, command: SavePlanDraftCommand) {
    return this.transaction(identity, async (client, actor) => {
      const project = await this.writer(client, actor, command.projectId);
      return this.idempotent(
        client,
        actor,
        'REPORT_PLAN_DRAFT',
        command.clientMutationId,
        command,
        async () => {
          // Same lock as confirmPlan: a confirm never deletes a draft saved after it read.
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
            [planLock(actor.orgId, project.id, command.targetBusinessDate)],
          );
          const before = await client.query<{ rows: PlanRowDto[] }>(
            `SELECT rows FROM "PlanDraft" WHERE "orgId"=$1 AND "projectId"=$2 AND "targetBusinessDate"=$3::date`,
            [actor.orgId, project.id, command.targetBusinessDate],
          );
          await client.query(
            `INSERT INTO "PlanDraft"(id,"orgId","projectId","targetBusinessDate",rows,"updatedBy") VALUES($1,$2,$3,$4::date,$5,$6)
          ON CONFLICT ("orgId","projectId","targetBusinessDate") DO UPDATE SET rows=excluded.rows,"updatedAt"=now(),"updatedBy"=excluded."updatedBy"`,
            [
              randomUUID(),
              actor.orgId,
              project.id,
              command.targetBusinessDate,
              JSON.stringify(command.rows),
              actor.accountId,
            ],
          );
          const plan = await planStateOf(
            client,
            actor.orgId,
            project.id,
            command.targetBusinessDate,
          );
          await this.audit(
            client,
            actor,
            {
              type: 'PLAN_DRAFT',
              id: project.id,
              version: plan.versions.length,
            },
            'REPORT_PLAN_DRAFT',
            command.targetBusinessDate,
            before.rows[0]?.rows ?? null,
            command.rows,
            command.clientMutationId,
          );
          return {
            targetBusinessDate: command.targetBusinessDate,
            status: planStatus(plan.state),
          };
        },
      );
    });
  }

  /** Rule 7: confirming creates a version from the draft; without a new draft nothing is created. */
  async confirmPlan(identity: Identity, command: ConfirmPlanCommand) {
    return this.transaction(identity, async (client, actor) => {
      const project = await this.writer(client, actor, command.projectId);
      return this.idempotent(
        client,
        actor,
        'REPORT_PLAN_CONFIRM',
        command.clientMutationId,
        command,
        async () => {
          // One confirmation at a time per target day; the unique (project, date, number) key is the backstop.
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
            [planLock(actor.orgId, project.id, command.targetBusinessDate)],
          );
          const plan = await planStateOf(
            client,
            actor.orgId,
            project.id,
            command.targetBusinessDate,
          );
          const previous = await planStateOf(
            client,
            actor.orgId,
            project.id,
            shiftDate(command.targetBusinessDate, -1),
          );
          const outcome = confirmPlan(
            plan.state,
            previous.state,
            new Date().toISOString(),
          );
          if (!outcome.ok)
            throw new ReportError(
              outcome.reason === 'noChange'
                ? 'PLAN_NO_CHANGE'
                : outcome.reason === 'emptyPlan'
                  ? 'PLAN_EMPTY'
                  : 'NUMBER_INVALID',
            );
          const id = randomUUID();
          await client.query(
            `INSERT INTO "PlanVersion"(id,"orgId","projectId","targetBusinessDate",number,rows,"confirmedBy") VALUES($1,$2,$3,$4::date,$5,$6,$7)`,
            [
              id,
              actor.orgId,
              project.id,
              command.targetBusinessDate,
              outcome.version.n,
              JSON.stringify(outcome.version.rows),
              actor.accountId,
            ],
          );
          await client.query(
            'DELETE FROM "PlanDraft" WHERE "orgId"=$1 AND "projectId"=$2 AND "targetBusinessDate"=$3::date',
            [actor.orgId, project.id, command.targetBusinessDate],
          );
          await this.audit(
            client,
            actor,
            { type: 'PLAN_VERSION', id, version: outcome.version.n },
            'REPORT_PLAN_CONFIRM',
            '',
            plan.state.draft,
            outcome.version.rows,
            command.clientMutationId,
          );
          return {
            targetBusinessDate: command.targetBusinessDate,
            n: outcome.version.n,
            rows: outcome.version.rows,
          };
        },
      );
    });
  }

  /** Master rows are upserted by (kind, key); rows not in the command are left untouched. */
  async saveItems(identity: Identity, command: SaveItemsCommand) {
    return this.transaction(identity, async (client, actor) => {
      const project = await this.writer(client, actor, command.projectId);
      return this.idempotent(
        client,
        actor,
        'REPORT_SAVE_ITEMS',
        command.clientMutationId,
        command,
        async () => {
          await lockProjectForNoKeyUpdate(client, actor.orgId, project.id);
          const before = await itemRows(client, actor.orgId, project.id);
          for (const item of command.items)
            await client.query(
              `INSERT INTO "ReportItem"(id,"orgId","projectId",kind,key,label,unit,"designQty","openingCumulative","sortOrder",active,"updatedBy","plannedDate")
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::date)
            ON CONFLICT ("orgId","projectId",kind,key) DO UPDATE SET label=excluded.label, unit=excluded.unit, "designQty"=excluded."designQty",
              "openingCumulative"=excluded."openingCumulative", "sortOrder"=excluded."sortOrder", active=excluded.active, "plannedDate"=CASE WHEN $14 THEN excluded."plannedDate" ELSE "ReportItem"."plannedDate" END, "updatedAt"=now(), "updatedBy"=excluded."updatedBy"`,
              [
                randomUUID(),
                actor.orgId,
                project.id,
                item.kind,
                item.key,
                item.label,
                item.unit,
                item.designQty,
                item.openingCumulative,
                item.sortOrder,
                item.active,
                actor.accountId,
                item.plannedDate ?? null,
                item.plannedDate !== undefined,
              ],
            );
          const after = await itemRows(client, actor.orgId, project.id);
          await this.audit(
            client,
            actor,
            { type: 'REPORT_ITEMS', id: project.id, version: 0 },
            'REPORT_SAVE_ITEMS',
            '',
            before.map(publicItem),
            after.map(publicItem),
            command.clientMutationId,
          );
          return {
            projectId: project.id,
            items: after.map(publicItem),
          };
        },
      );
    });
  }
}
// ---------- rows (report module internal: report-store and report-reader only) ----------
// ---------- days ----------
export async function dayRow(
  client: PoolClient,
  orgId: string,
  projectId: string,
  businessDate: string,
  lock = false,
): Promise<DayRow | null> {
  const result = await client.query<DayRow>(
    `SELECT id, version, state, "currentRevisionNumber", "correctionReason", "siteTimezone", "updatedAt"
    FROM "DailyClose" WHERE "orgId"=$1 AND "projectId"=$2 AND "businessDate"=$3::date AND "scopeKey"=$4${lock ? ' FOR UPDATE' : ''}`,
    [orgId, projectId, businessDate, REPORT_SCOPE],
  );
  return result.rows[0] ?? null;
}

export function dayState(d: DayRow | null, facts: DayFacts | null): DayState {
  if (!d) return 'empty';
  if (d.state === 'SUBMITTED')
    return d.correctionReason === null ? 'submitted' : 'correcting';
  return facts && hasFacts(facts) ? 'draft' : 'empty';
}

export async function draftFacts(
  client: PoolClient,
  orgId: string,
  dailyCloseId: string,
) {
  const r = await client.query<{ facts: DayFactsDto }>(
    'SELECT facts FROM "DailyReportDraft" WHERE "orgId"=$1 AND "dailyCloseId"=$2',
    [orgId, dailyCloseId],
  );
  return r.rows[0]?.facts ?? null;
}

export async function revisionRows(
  client: PoolClient,
  orgId: string,
  dailyCloseId: string,
) {
  const r = await client.query<RevisionRow>(
    `SELECT "revisionNumber", reason, "submittedAt", "updatedBy", snapshot FROM "Revision"
    WHERE "orgId"=$1 AND "dailyCloseId"=$2 ORDER BY "revisionNumber"`,
    [orgId, dailyCloseId],
  );
  return r.rows;
}

/** Rule 3: carry-over comes from the latest submitted day before this one, however many days back. */
async function previousSubmitted(
  client: PoolClient,
  orgId: string,
  projectId: string,
  businessDate: string,
): Promise<{
  businessDate: string;
  snapshot: Record<string, unknown>;
} | null> {
  const r = await client.query<{
    businessDate: string;
    snapshot: Record<string, unknown>;
  }>(
    `SELECT d."businessDate"::text AS "businessDate", r.snapshot FROM "DailyClose" d
    JOIN "Revision" r ON r."orgId"=d."orgId" AND r."dailyCloseId"=d.id AND r."revisionNumber"=d."currentRevisionNumber"
    WHERE d."orgId"=$1 AND d."projectId"=$2 AND d."scopeKey"=$3 AND d.state='SUBMITTED' AND d."businessDate"<$4::date
    ORDER BY d."businessDate" DESC LIMIT 1`,
    [orgId, projectId, REPORT_SCOPE, businessDate],
  );
  return r.rows[0] ?? null;
}

// ---------- items ----------
export async function itemRows(
  client: PoolClient,
  orgId: string,
  projectId: string,
) {
  const r = await client.query<ItemRow>(
    `SELECT id, kind, key, label, unit, "designQty", "openingCumulative", "sortOrder", active,"plannedDate"::text AS "plannedDate"
    FROM "ReportItem" WHERE "orgId"=$1 AND "projectId"=$2 ORDER BY kind, "sortOrder", key`,
    [orgId, projectId],
  );
  return r.rows;
}

function activeKeys(items: ItemRow[], kind: ReportItemDto['kind']) {
  return items.filter((i) => i.kind === kind && i.active).map((i) => i.key);
}

// ---------- plans ----------
export async function planStateOf(
  client: PoolClient,
  orgId: string,
  projectId: string,
  target: string,
): Promise<{ state: PlanState; versions: PlanVersionRow[] }> {
  const versions = await client.query<PlanVersionRow>(
    `SELECT number, rows, "confirmedAt", "confirmedBy" FROM "PlanVersion"
    WHERE "orgId"=$1 AND "projectId"=$2 AND "targetBusinessDate"=$3::date ORDER BY number`,
    [orgId, projectId, target],
  );
  const draft = await client.query<{ rows: PlanRowDto[] }>(
    `SELECT rows FROM "PlanDraft" WHERE "orgId"=$1 AND "projectId"=$2 AND "targetBusinessDate"=$3::date`,
    [orgId, projectId, target],
  );
  return {
    versions: versions.rows,
    state: {
      versions: versions.rows.map((v) => ({
        n: v.number,
        rows: v.rows,
        at: v.confirmedAt.toISOString(),
      })),
      draft: draft.rows[0]?.rows ?? null,
    },
  };
}

function baselineOf(state: PlanState): PlanVersion | null {
  return state.versions.at(-1) ?? null;
}

// ---------- snapshot (what a submission freezes; rule 1 and 3) ----------
export async function daySnapshot(
  client: PoolClient,
  actor: Actor,
  project: ProjectRow,
  businessDate: string,
  facts: DayFacts,
  items: ItemRow[],
) {
  const today = await planStateOf(
    client,
    actor.orgId,
    project.id,
    businessDate,
  );
  const next = shiftDate(businessDate, 1);
  const nextPlan = await planStateOf(client, actor.orgId, project.id, next);
  const previous = await previousSubmitted(
    client,
    actor.orgId,
    project.id,
    businessDate,
  );
  const previousCumulative =
    (previous?.snapshot['cumulativeCarry'] as
      Record<string, CarriedCumulative> | undefined) ?? {};
  const cumulativeCarry = carryCumulative(
    businessDate,
    facts,
    previousCumulative,
  );
  const previousMaterials =
    (previous?.snapshot['materialsCumulative'] as
      Record<string, MaterialCumulative> | undefined) ?? {};
  const materialsCumulative: Record<string, MaterialCumulative> = {};
  for (const m of items.filter((i) => i.kind === 'material')) {
    const opening = dec(m.openingCumulative);
    const base: MaterialCumulative = previous
      ? (previousMaterials[m.key] ?? { value: null, complete: false })
      : {
          value: opening === null ? null : decText(opening),
          complete: opening !== null,
        };
    materialsCumulative[m.key] = carryMaterial(
      base,
      facts.materials[m.key],
      facts.noWork !== null,
    );
  }
  const baseline = baselineOf(today.state);
  // Rule 1 and 8: the day's photos with a valid current link are the submitted evidence,
  // frozen with that link; a later relink never reaches a revision. Unlinked photos are
  // staging only: left out, still linkable later. Coverage asks for a photo where a work
  // item has quantity today.
  const photos = await photosOfDay(
    client,
    actor.orgId,
    project.id,
    businessDate,
  );
  const evidence = submittedPhotos(photos, new Set(activeKeys(items, 'work')));
  const cov = coverage({
    facts,
    itemIds: activeKeys(items, 'work'),
    machineryIds: activeKeys(items, 'machinery'),
    materialIds: activeKeys(items, 'material'),
    baseline,
    photographedItems: photographedItems(evidence),
  });
  const nextStatus = planStatus(nextPlan.state);
  // Rule 1: the issues of the day as they stand now; later edits never reach a revision.
  const issues = await issuesAsOf(
    client,
    actor.orgId,
    project.id,
    businessDate,
  );
  // Design §4: the foreman claims beside the PM's facts (never merged into them). The caller
  // holds the shared roster lock; a submission also holds the day lock.
  const foreman = await foremanDayAsOf(
    client,
    actor.orgId,
    project.id,
    businessDate,
    project.timezone,
    activeKeys(items, 'work'),
  );
  return {
    coverage: cov,
    photos,
    unlinkedPhotos: photos.length - evidence.length,
    snapshot: {
      businessDate,
      siteTimezone: project.timezone,
      projectId: project.id,
      projectCode: project.code,
      projectName: project.name,
      facts,
      items: items.map(publicItem),
      baseline: baseline ? { n: baseline.n, rows: baseline.rows } : null,
      nextPlan: {
        status: nextStatus.status,
        n: nextStatus.n,
        rows: planRows(nextPlan.state, today.state),
      },
      previousSubmittedDate: previous?.businessDate ?? null,
      cumulativeBase: previousCumulative,
      cumulativeCarry,
      materialsCumulative,
      issues,
      photos: evidence.map(photoAsOf),
      coverage: cov,
      foreman,
      actorAccountId: actor.accountId,
      actorPersonId: actor.personId,
    },
  };
}

export type { Coverage as ReportCoverage };
