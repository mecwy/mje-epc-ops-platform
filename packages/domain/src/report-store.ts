import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  CancelCorrectionCommand,
  ConfirmPlanCommand,
  DayFactsDto,
  NoWorkCommand,
  PlanRowDto,
  ReportItemDto,
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
  projectAccess,
  projectWriter,
  type Access,
  type Actor,
  type ReportProjectRow,
} from './store-kit.js';
import { issuesAsOf } from './issue-store.js';
import {
  photoAsOf,
  photographedItems,
  photosOfDay,
  submittedPhotos,
} from './photo-store.js';

export {
  READ_ROLES,
  REPORT_SCOPE,
  ReportError,
  WRITE_ROLES,
  type ReportProjectRow,
};
type ProjectRow = ReportProjectRow;
interface DayRow {
  id: string;
  version: number;
  state: string;
  currentRevisionNumber: number;
  correctionReason: string | null;
  siteTimezone: string;
  updatedAt: Date;
}
interface RevisionRow {
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
interface ItemRow extends ReportItemDto {
  id: string;
}
const publicItem = (r: ItemRow): ReportItemDto => ({
  kind: r.kind,
  key: r.key,
  label: r.label,
  unit: r.unit,
  designQty: r.designQty,
  openingCumulative: r.openingCumulative,
  sortOrder: r.sortOrder,
  active: r.active,
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
  private access(client: PoolClient, actor: Actor, projectId: string) {
    return projectAccess(client, actor, projectId);
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

  // ---------- days ----------
  private async day(
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
      return (await this.day(
        client,
        actor.orgId,
        project.id,
        businessDate,
        true,
      ))!;
    }
    const existing = await this.day(
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
  private static state(d: DayRow | null, facts: DayFacts | null): DayState {
    if (!d) return 'empty';
    if (d.state === 'SUBMITTED')
      return d.correctionReason === null ? 'submitted' : 'correcting';
    return facts && hasFacts(facts) ? 'draft' : 'empty';
  }
  private async facts(client: PoolClient, orgId: string, dailyCloseId: string) {
    const r = await client.query<{ facts: DayFactsDto }>(
      'SELECT facts FROM "DailyReportDraft" WHERE "orgId"=$1 AND "dailyCloseId"=$2',
      [orgId, dailyCloseId],
    );
    return r.rows[0]?.facts ?? null;
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
  private async revisions(
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
  private async previousSubmitted(
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
  private async items(client: PoolClient, orgId: string, projectId: string) {
    const r = await client.query<ItemRow>(
      `SELECT id, kind, key, label, unit, "designQty", "openingCumulative", "sortOrder", active
      FROM "ReportItem" WHERE "orgId"=$1 AND "projectId"=$2 ORDER BY kind, "sortOrder", key`,
      [orgId, projectId],
    );
    return r.rows;
  }
  private static keys(items: ItemRow[], kind: ReportItemDto['kind']) {
    return items.filter((i) => i.kind === kind && i.active).map((i) => i.key);
  }

  // ---------- plans ----------
  private async planState(
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
  private static baseline(state: PlanState): PlanVersion | null {
    return state.versions.at(-1) ?? null;
  }

  // ---------- snapshot (what a submission freezes; rule 1 and 3) ----------
  private async snapshot(
    client: PoolClient,
    actor: Actor,
    project: ProjectRow,
    businessDate: string,
    facts: DayFacts,
    items: ItemRow[],
  ) {
    const today = await this.planState(
      client,
      actor.orgId,
      project.id,
      businessDate,
    );
    const next = shiftDate(businessDate, 1);
    const nextPlan = await this.planState(
      client,
      actor.orgId,
      project.id,
      next,
    );
    const previous = await this.previousSubmitted(
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
    const baseline = ReportStore.baseline(today.state);
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
    const evidence = submittedPhotos(
      photos,
      new Set(ReportStore.keys(items, 'work')),
    );
    const cov = coverage({
      facts,
      itemIds: ReportStore.keys(items, 'work'),
      machineryIds: ReportStore.keys(items, 'machinery'),
      materialIds: ReportStore.keys(items, 'material'),
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
        actorAccountId: actor.accountId,
        actorPersonId: actor.personId,
      },
    };
  }

  // ---------- reads ----------
  async projects(identity: Identity) {
    return this.transaction(identity, async (client, actor) => {
      const result = await client.query<ProjectRow & { access: Access }>(
        `SELECT p.id, p.name, p.code, p.timezone,
          CASE WHEN bool_or(m.role = ANY($3::text[])) THEN 'write' ELSE 'read' END AS access
        FROM "Project" p JOIN "Membership" m ON m."orgId"=p."orgId" AND (m."projectId"=p.id OR (m."projectId" IS NULL AND m.role = ANY($4::text[])))
        WHERE p."orgId"=$1 AND m."accountId"=$2 AND m.role = ANY($5::text[])
          AND m."activeFrom"<=now() AND (m."activeUntil" IS NULL OR m."activeUntil">now())
        GROUP BY p.id, p.name, p.code, p.timezone ORDER BY p.code`,
        [
          actor.orgId,
          actor.accountId,
          [...WRITE_ROLES],
          [...READ_ROLES],
          [...WRITE_ROLES, ...READ_ROLES],
        ],
      );
      return {
        accountId: actor.accountId,
        personId: actor.personId,
        projects: result.rows,
      };
    });
  }

  /** Day rows in a date range (at most 62 days). Reading never creates a row (rule 3). */
  async days(identity: Identity, projectId: string, from: string, to: string) {
    return this.transaction(identity, async (client, actor) => {
      await this.access(client, actor, projectId);
      const result = await client.query<{
        businessDate: string;
        state: string;
        currentRevisionNumber: number;
        correcting: boolean;
        hasFacts: boolean;
      }>(
        `SELECT d."businessDate"::text AS "businessDate", d.state, d."currentRevisionNumber",
          d."correctionReason" IS NOT NULL AS correcting, r.facts IS NOT NULL AS "hasFacts"
        FROM "DailyClose" d LEFT JOIN "DailyReportDraft" r ON r."orgId"=d."orgId" AND r."dailyCloseId"=d.id
        WHERE d."orgId"=$1 AND d."projectId"=$2 AND d."scopeKey"=$3 AND d."businessDate" BETWEEN $4::date AND $5::date
          AND $5::date - $4::date BETWEEN 0 AND 61
        ORDER BY d."businessDate"`,
        [actor.orgId, projectId, REPORT_SCOPE, from, to],
      );
      return result.rows.map((r) => ({
        businessDate: r.businessDate,
        state:
          r.state === 'SUBMITTED'
            ? r.correcting
              ? 'correcting'
              : 'submitted'
            : r.hasFacts
              ? 'draft'
              : 'empty',
        revision: r.currentRevisionNumber,
      }));
    });
  }

  async getDay(identity: Identity, projectId: string, businessDate: string) {
    return this.transaction(identity, async (client, actor) => {
      const { project, access } = await this.access(client, actor, projectId);
      const day = await this.day(client, actor.orgId, projectId, businessDate);
      const facts = day ? await this.facts(client, actor.orgId, day.id) : null;
      const items = await this.items(client, actor.orgId, projectId);
      const revisions = day
        ? await this.revisions(client, actor.orgId, day.id)
        : [];
      const {
        snapshot,
        coverage: cov,
        photos,
        unlinkedPhotos,
      } = await this.snapshot(
        client,
        actor,
        project,
        businessDate,
        facts ?? blankFacts(),
        items,
      );
      const today = await this.planState(
        client,
        actor.orgId,
        projectId,
        businessDate,
      );
      return {
        access,
        projectId,
        businessDate,
        siteTimezone: project.timezone,
        state: ReportStore.state(day, facts),
        version: day?.version ?? 0,
        currentRevisionNumber: day?.currentRevisionNumber ?? 0,
        correctionReason: day?.correctionReason ?? null,
        facts: facts ?? blankFacts(),
        items: snapshot.items,
        planStatus: planStatus(today.state),
        baseline: snapshot.baseline,
        nextPlan: snapshot.nextPlan,
        previousSubmittedDate: snapshot.previousSubmittedDate,
        cumulativeBase: snapshot.cumulativeBase,
        materialsCumulative: snapshot.materialsCumulative,
        issues: snapshot.issues,
        photos,
        /** Photos a submission would leave out (no valid current link); prompt before submit. */
        unlinkedPhotos,
        coverage: cov,
        revisions: revisions.map((r) => ({
          n: r.revisionNumber,
          at: r.submittedAt.toISOString(),
          by: r.updatedBy,
          reason: r.reason,
        })),
      };
    });
  }

  async getRevision(
    identity: Identity,
    projectId: string,
    businessDate: string,
    revisionNumber: number,
  ) {
    return this.transaction(identity, async (client, actor) => {
      await this.access(client, actor, projectId);
      const day = await this.day(client, actor.orgId, projectId, businessDate);
      if (!day) throw new ReportError('NOT_FOUND');
      const r = (await this.revisions(client, actor.orgId, day.id)).find(
        (x) => x.revisionNumber === revisionNumber,
      );
      if (!r) throw new ReportError('NOT_FOUND');
      return {
        n: r.revisionNumber,
        at: r.submittedAt.toISOString(),
        by: r.updatedBy,
        reason: r.reason,
        snapshot: r.snapshot,
      };
    });
  }

  async getPlan(identity: Identity, projectId: string, target: string) {
    return this.transaction(identity, async (client, actor) => {
      await this.access(client, actor, projectId);
      const plan = await this.planState(client, actor.orgId, projectId, target);
      const previous = await this.planState(
        client,
        actor.orgId,
        projectId,
        shiftDate(target, -1),
      );
      return {
        targetBusinessDate: target,
        status: planStatus(plan.state),
        rows: planRows(plan.state, previous.state),
        draft: plan.state.draft,
        versions: plan.versions.map((v) => ({
          n: v.number,
          rows: v.rows,
          at: v.confirmedAt.toISOString(),
          by: v.confirmedBy,
        })),
      };
    });
  }

  async getItems(identity: Identity, projectId: string) {
    return this.transaction(identity, async (client, actor) => {
      await this.access(client, actor, projectId);
      return (await this.items(client, actor.orgId, projectId)).map(publicItem);
    });
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
          const before = await this.facts(client, actor.orgId, day.id);
          await this.saveDraft(client, actor, day.id, command.facts);
          await this.audit(
            client,
            actor,
            { type: 'SITE_DAILY_CLOSE', id: day.id, version: day.version },
            'REPORT_SAVE_FACTS',
            '',
            before,
            command.facts,
            command.clientMutationId,
          );
          return {
            businessDate: command.businessDate,
            version: day.version,
            state: ReportStore.state(day, command.facts),
          };
        },
      );
    });
  }

  private async submitRevision(
    client: PoolClient,
    actor: Actor,
    project: ProjectRow,
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
    const items = await this.items(client, actor.orgId, project.id);
    const { snapshot, coverage: cov } = await this.snapshot(
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
      const project = await this.writer(client, actor, command.projectId);
      return this.idempotent(
        client,
        actor,
        'REPORT_SUBMIT',
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
          const facts =
            (await this.facts(client, actor.orgId, day.id)) ?? blankFacts();
          if (!(await this.facts(client, actor.orgId, day.id)))
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
      const project = await this.writer(client, actor, command.projectId);
      return this.idempotent(
        client,
        actor,
        'REPORT_NO_WORK',
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
          const facts: DayFacts = {
            ...((await this.facts(client, actor.orgId, day.id)) ??
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
          const day = await this.day(
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
          const day = await this.day(
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
            await this.revisions(client, actor.orgId, day.id)
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
          const plan = await this.planState(
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
          const plan = await this.planState(
            client,
            actor.orgId,
            project.id,
            command.targetBusinessDate,
          );
          const previous = await this.planState(
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
          const before = await this.items(client, actor.orgId, project.id);
          for (const item of command.items)
            await client.query(
              `INSERT INTO "ReportItem"(id,"orgId","projectId",kind,key,label,unit,"designQty","openingCumulative","sortOrder",active,"updatedBy")
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            ON CONFLICT ("orgId","projectId",kind,key) DO UPDATE SET label=excluded.label, unit=excluded.unit, "designQty"=excluded."designQty",
              "openingCumulative"=excluded."openingCumulative", "sortOrder"=excluded."sortOrder", active=excluded.active, "updatedAt"=now(), "updatedBy"=excluded."updatedBy"`,
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
              ],
            );
          const after = await this.items(client, actor.orgId, project.id);
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
export type { Coverage as ReportCoverage };
