import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  AdmitMaterialUseCommand,
  InitializeMaterialScopeCommand,
  MaterialContinuityView,
  MaterialScopeDto,
  MaterialSourceDto,
  DayFactsDto,
  ReportActivity,
} from '@mje/contracts';
import { InvalidReportInput } from '@mje/contracts';
import type { Identity } from './alpha-store.js';
import type { IssueStore } from './index.js';
import { issueReader, withIssueReadContext } from './issue-reader.js';
import {
  inTransaction,
  projectAccess,
  projectWriter,
  idempotent,
  audit,
  ReportError,
  type Actor,
} from './store-kit.js';
import { dec, decText } from './report-rules.js';
import {
  projectMaterialQuantities,
  isMaterialOpeningDayStart,
  type MaterialQuantityMovement,
  materialUseDifference,
  missingMaterialDays,
} from './material-continuity-rules.js';

/** Scope-wide serialization precedes every day lock used for submission/admission. */
export async function lockMaterialProject(
  client: PoolClient,
  orgId: string,
  projectId: string,
) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `${orgId}:material-quantity:${projectId}`,
  ]);
}
interface ScopeRow extends MaterialScopeDto {
  orgId: string;
}
interface MovementRow extends MaterialQuantityMovement {
  id: string;
  sequence: number;
  createdAt: string;
}
interface SourceRow {
  businessDate: string;
  revisionId: string;
  revisionNumber: number;
  facts: Pick<DayFactsDto, 'activities' | 'materials'>;
}
interface AdmissionRow {
  scopeId: string;
  useFactId: string;
  sourceBusinessDate: string;
  sourceRevisionId: string;
  movementId: string;
  quantity: string;
  movementKind: 'use' | 'reversal';
  sourceActivity: ReportActivity | null;
  issueId: string | null;
  dueAt: string | null;
}
const SCOPE_COLUMNS = `id,"orgId","projectId",version,"materialItemId","materialKey",specification,unit,"workPackageId","scopeVersion",ownership,custody,location,"openingDate"::text AS "openingDate","openingCutoffAt"::text AS "openingCutoffAt","openingQuantity"::text AS "openingQuantity","openingBasis"`;
async function scopes(client: PoolClient, orgId: string, projectId: string) {
  return (
    await client.query<ScopeRow>(
      `SELECT ${SCOPE_COLUMNS} FROM "MaterialQuantityScope" WHERE "orgId"=$1 AND "projectId"=$2 ORDER BY id`,
      [orgId, projectId],
    )
  ).rows.map((r) => ({
    ...r,
    openingCutoffAt: new Date(r.openingCutoffAt).toISOString(),
  }));
}
async function movements(client: PoolClient, orgId: string, scopeId: string) {
  return (
    await client.query<MovementRow>(
      `SELECT id,kind,quantity::text,"businessDate"::text AS "businessDate",sequence,"createdAt"::text AS "createdAt" FROM "MaterialQuantityMovement" WHERE "orgId"=$1 AND "scopeId"=$2 ORDER BY sequence,id`,
      [orgId, scopeId],
    )
  ).rows;
}
async function admissions(client: PoolClient, orgId: string, scopeId: string) {
  return (
    await client.query<AdmissionRow>(
      `SELECT a."scopeId",a."useFactId",a."sourceBusinessDate"::text AS "sourceBusinessDate",a."sourceRevisionId",a."movementId",(CASE WHEN m.kind='use' THEN -m.quantity ELSE 0 END)::text AS quantity,m.kind AS "movementKind",a."issueId",a."dueAt"::text AS "dueAt",
       (SELECT fact FROM jsonb_array_elements(COALESCE(r.snapshot->'facts'->'activities','[]'::jsonb)) fact WHERE fact->'use'->>'id'=a."useFactId"::text LIMIT 1) AS "sourceActivity"
       FROM "MaterialUseAdmission" a JOIN "MaterialQuantityMovement" m ON m."orgId"=a."orgId" AND m.id=a."movementId" JOIN "Revision" r ON r."orgId"=a."orgId" AND r.id=a."sourceRevisionId" WHERE a."orgId"=$1 AND a."scopeId"=$2`,
      [orgId, scopeId],
    )
  ).rows.map((r) => ({
    ...r,
    dueAt: r.dueAt === null ? null : new Date(r.dueAt).toISOString(),
  }));
}
async function sources(
  client: PoolClient,
  orgId: string,
  projectId: string,
  from: string,
  to: string,
) {
  return (
    await client.query<SourceRow>(
      `SELECT d."businessDate"::text AS "businessDate",r.id AS "revisionId",r."revisionNumber",r.snapshot->'facts' AS facts FROM "DailyClose" d JOIN "Revision" r ON r."orgId"=d."orgId" AND r."dailyCloseId"=d.id AND r."revisionNumber"=d."currentRevisionNumber" WHERE d."orgId"=$1 AND d."projectId"=$2 AND d."businessDate" BETWEEN $3::date AND $4::date ORDER BY d."businessDate"`,
      [orgId, projectId, from, to],
    )
  ).rows;
}
function matches(a: ReportActivity, scope: MaterialScopeDto) {
  return (
    a.workPackageId === scope.workPackageId &&
    a.scopeVersion === scope.scopeVersion &&
    a.use?.materialItemId === scope.materialItemId &&
    a.use.materialKey === scope.materialKey &&
    a.use.specification === scope.specification &&
    a.use.unit === scope.unit
  );
}
type Followup = Awaited<
  ReturnType<ReturnType<typeof issueReader.forContext>['materialFollowups']>
>[number];
function validFollowup(issue: Followup | undefined, activity: ReportActivity) {
  return (
    !!issue &&
    issue.workItemKey === activity.workItemKey &&
    !!issue.ownerPersonId &&
    !!issue.dueOn &&
    issue.closedOn === null
  );
}
function sourceViews(
  scope: MaterialScopeDto,
  rows: SourceRow[],
  active: AdmissionRow[],
  linked: Followup[],
): MaterialSourceDto[] {
  const visible: MaterialSourceDto[] = rows.flatMap((r) =>
    (r.facts.activities ?? [])
      .filter(
        (a) =>
          matches(a, scope) ||
          active.some(
            (x) =>
              x.movementKind === 'use' &&
              x.useFactId === a.use?.id &&
              x.sourceBusinessDate === r.businessDate,
          ),
      )
      .map((a) => {
        const use = a.use!;
        const previous = active.find((x) => x.useFactId === use.id);
        const deducted = previous?.movementKind === 'use';
        const quantity =
          matches(a, scope) && use.state === 'declared'
            ? dec(use.actualQuantity)
            : null;
        const rule = materialUseDifference(a);
        const followupSatisfied = validFollowup(
          linked.find((i) => i.id === previous?.issueId),
          a,
        );
        const same =
          quantity !== null && deducted && dec(previous.quantity) === quantity;
        return {
          sourceBusinessDate: r.businessDate,
          revisionNumber: r.revisionNumber,
          useFactId: use.id,
          outputFactId: a.outputFactId,
          workItemKey: a.workItemKey,
          quantity: quantity === null ? null : decText(quantity),
          outputQuantity:
            dec(a.quantity) === null ? null : decText(dec(a.quantity)!),
          ...rule,
          followupRequired: quantity !== null && rule.followupRequired,
          note: use.differenceNote,
          state:
            quantity === null
              ? deducted
                ? 'reversalPending'
                : 'pending'
              : rule.followupRequired && !followupSatisfied
                ? 'followupPending'
                : same && previous.sourceRevisionId === r.revisionId
                  ? 'included'
                  : deducted
                    ? 'correctionPending'
                    : 'ready',
          admittedQuantity: deducted ? decText(dec(previous.quantity)!) : null,
          issueId: previous?.issueId ?? null,
          dueAt: null,
        };
      }),
  );
  for (const admission of active.filter((a) => a.movementKind === 'use')) {
    if (visible.some((s) => s.useFactId === admission.useFactId)) continue;
    const row = rows.find(
      (r) => r.businessDate === admission.sourceBusinessDate,
    );
    if (!row) continue; // Outside the queried window; a genuinely missing day is counted separately.
    const old = admission.sourceActivity;
    if (!old) throw new InvalidReportInput('material.admissionSource');
    visible.push({
      sourceBusinessDate: row.businessDate,
      revisionNumber: row.revisionNumber,
      useFactId: admission.useFactId,
      outputFactId: old.outputFactId,
      workItemKey: old.workItemKey,
      quantity: null,
      outputQuantity: null,
      expectedConsumption: null,
      difference: null,
      note: '',
      state: 'reversalPending',
      followupRequired: false,
      admittedQuantity: admission.quantity,
      issueId: admission.issueId,
      dueAt: null,
    });
  }
  return visible;
}
async function scopeView(
  client: PoolClient,
  actor: Actor,
  scope: ScopeRow,
  businessDate: string,
  currentFacts?: Pick<DayFactsDto, 'activities' | 'materials'>,
): Promise<MaterialContinuityView['scopes'][number]> {
  const rows = await sources(
    client,
    actor.orgId,
    scope.projectId,
    scope.openingDate,
    businessDate,
  );
  // During submission, use the facts being frozen rather than the still-current old revision.
  if (currentFacts) {
    const old = rows.findIndex((x) => x.businessDate === businessDate);
    if (old >= 0) rows.splice(old, 1);
    rows.push({
      businessDate,
      revisionId: '',
      revisionNumber: 0,
      facts: currentFacts,
    });
  }
  const active = await admissions(client, actor.orgId, scope.id);
  const events = await movements(client, actor.orgId, scope.id);
  const linked = await withIssueReadContext(client, actor, (ctx) =>
    issueReader
      .forContext(ctx)
      .materialFollowups(scope.projectId, [
        ...new Set(active.flatMap((a) => (a.issueId ? [a.issueId] : []))),
      ]),
  );
  const source = sourceViews(scope, rows, active, linked);
  const unsupported = rows.filter(
    (r) => !['0', 'na'].includes(r.facts.materials[scope.materialKey] ?? ''),
  ).length;
  const pending =
    source.filter((r) => r.state !== 'included').length +
    unsupported +
    missingMaterialDays(
      scope.openingDate,
      businessDate,
      rows.map((r) => r.businessDate),
    );
  const current = projectMaterialQuantities(
    scope.id,
    businessDate,
    scope.openingQuantity !== null && businessDate >= scope.openingDate,
    events,
    pending,
    scope.version,
  );
  const versions = [...new Set(events.map((e) => e.sequence))].sort(
    (a, b) => a - b,
  );
  const history = versions.map((v) => ({
    ledgerVersion: v,
    recordedAt: events.find((e) => e.sequence === v)!.createdAt,
    balance: projectMaterialQuantities(
      scope.id,
      businessDate,
      scope.openingQuantity !== null && businessDate >= scope.openingDate,
      events.filter((e) => e.sequence <= v),
      0,
      v,
    ).balance,
  }));
  const { orgId: _orgId, ...dto } = scope;
  void _orgId;
  return {
    scope: dto,
    current,
    sources: source,
    followups: source.flatMap((s) => {
      const issue = linked.find((i) => i.id === s.issueId);
      return issue
        ? [
            {
              issueId: issue.id,
              useFactId: s.useFactId,
              title: issue.title,
              ownerPersonId: issue.ownerPersonId,
              ownerLabel: null,
              dueOn: issue.dueOn,
              dueAt: null,
              state: issue.state,
            },
          ]
        : [];
    }),
    history,
  };
}
/** Frozen inside normal ReportStore submission only; no existing Revision is modified. */
export async function materialQuantitiesAsOf(
  client: PoolClient,
  actor: Actor,
  projectId: string,
  businessDate: string,
  facts?: Pick<DayFactsDto, 'activities' | 'materials'>,
) {
  const result = [];
  for (const scope of await scopes(client, actor.orgId, projectId))
    result.push(
      (await scopeView(client, actor, scope, businessDate, facts)).current,
    );
  return result;
}

export class MaterialContinuityStore {
  constructor(
    private readonly pool: Pool,
    _issueStore: IssueStore,
    private readonly peopleLabels?: (
      identity: Identity,
      projectId: string,
    ) => Promise<Record<string, string>>,
  ) {}
  async view(
    identity: Identity,
    projectId: string,
    businessDate: string,
    revisionNumber?: number,
  ): Promise<MaterialContinuityView> {
    const result = await inTransaction(
      this.pool,
      identity,
      async (client, actor) => {
        const { access } = await projectAccess(client, actor, projectId);
        await lockMaterialProject(client, actor.orgId, projectId);
        const list = [];
        for (const scope of await scopes(client, actor.orgId, projectId))
          list.push(await scopeView(client, actor, scope, businessDate));
        const revisions = await client.query<{
          snapshot: Record<string, unknown>;
        }>(
          `SELECT r.snapshot FROM "Revision" r JOIN "DailyClose" d ON d."orgId"=r."orgId" AND d.id=r."dailyCloseId" WHERE d."orgId"=$1 AND d."projectId"=$2 AND d."businessDate"=$3::date AND r."revisionNumber"=COALESCE($4::int,d."currentRevisionNumber")`,
          [actor.orgId, projectId, businessDate, revisionNumber ?? null],
        );
        if (revisionNumber !== undefined && !revisions.rows[0])
          throw new ReportError('NOT_FOUND');
        const frozen = revisions.rows[0]?.snapshot['materialQuantities'];
        return {
          projectId,
          businessDate,
          access,
          scopes: list,
          frozen: Array.isArray(frozen)
            ? (frozen as MaterialContinuityView['frozen'])
            : null,
        };
      },
    );
    // Public issue service supplies current responsibility/history; the ledger never writes Issue tables.
    const names: Record<string, string> =
      result.access === 'write' && this.peopleLabels
        ? await this.peopleLabels(identity, projectId).catch(() => ({}))
        : {};
    for (const scope of result.scopes)
      for (const followup of scope.followups)
        followup.ownerLabel = followup.ownerPersonId
          ? (names[followup.ownerPersonId] ?? null)
          : null;
    return result;
  }
  async initialize(
    identity: Identity,
    command: InitializeMaterialScopeCommand,
  ) {
    return inTransaction(this.pool, identity, async (client, actor) => {
      const project = await projectWriter(client, actor, command.projectId);
      return idempotent(
        client,
        actor,
        'MATERIAL_SCOPE_INITIALIZE',
        command.clientMutationId,
        command,
        async () => {
          await lockMaterialProject(client, actor.orgId, project.id);
          const item = await client.query<{ key: string; unit: string }>(
            `SELECT key,unit FROM "ReportItem" WHERE "orgId"=$1 AND "projectId"=$2 AND id=$3 AND kind='material' AND active`,
            [actor.orgId, project.id, command.materialItemId],
          );
          if (
            item.rows[0]?.key !== command.materialKey ||
            item.rows[0]?.unit !== command.unit
          )
            throw new InvalidReportInput('material.identity');
          if (
            !isMaterialOpeningDayStart(
              command.openingCutoffAt,
              command.openingDate,
              project.timezone,
            )
          )
            throw new InvalidReportInput('material.openingCutoffAt');
          const id = randomUUID();
          await client.query(
            `INSERT INTO "MaterialQuantityScope"(id,"orgId","projectId","materialItemId","materialKey",specification,unit,"workPackageId","scopeVersion",ownership,custody,location,"openingDate","openingCutoffAt","openingQuantity","openingBasis","updatedBy") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::date,$14,$15,$16,$17)`,
            [
              id,
              actor.orgId,
              project.id,
              command.materialItemId,
              command.materialKey,
              command.specification,
              command.unit,
              command.workPackageId,
              command.scopeVersion,
              command.ownership,
              command.custody,
              command.location,
              command.openingDate,
              command.openingCutoffAt,
              command.openingQuantity,
              command.openingBasis,
              actor.accountId,
            ],
          );
          if (command.openingQuantity !== null)
            await this.movement(
              client,
              actor,
              id,
              1,
              'opening',
              decText(dec(command.openingQuantity)!),
              command.openingDate,
              null,
              null,
              null,
              command.openingBasis,
            );
          await audit(
            client,
            actor,
            { type: 'MATERIAL_QUANTITY_SCOPE', id, version: 1 },
            'MATERIAL_OPENING',
            'Documented site quantity opening; not verified stock availability',
            null,
            command,
            command.clientMutationId,
          );
          return { scopeId: id, version: 1 };
        },
      );
    });
  }
  async admit(identity: Identity, command: AdmitMaterialUseCommand) {
    return inTransaction(this.pool, identity, async (client, actor) => {
      const project = await projectWriter(client, actor, command.projectId);
      return idempotent(
        client,
        actor,
        'MATERIAL_USE_ADMIT',
        command.clientMutationId,
        command,
        async () => {
          await lockMaterialProject(client, actor.orgId, project.id);
          const scope = (await scopes(client, actor.orgId, project.id)).find(
            (s) => s.id === command.scopeId,
          );
          if (!scope) throw new ReportError('NOT_FOUND');
          if (scope.version !== command.expectedVersion)
            throw new ReportError('VERSION_CONFLICT');
          for (const id of command.records.map((r) => r.useFactId).sort())
            await client.query(
              'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
              [`${actor.orgId}:material-use-fact:${id}`],
            );
          for (const date of [
            ...new Set(command.records.map((r) => r.sourceBusinessDate)),
          ].sort()) {
            await client.query(
              `SELECT id FROM "DailyClose" WHERE "orgId"=$1 AND "projectId"=$2 AND "businessDate"=$3::date FOR UPDATE`,
              [actor.orgId, project.id, date],
            );
          }
          const rows = await sources(
            client,
            actor.orgId,
            project.id,
            scope.openingDate,
            command.businessDate,
          );
          const before = await admissions(client, actor.orgId, scope.id);
          const linked = await withIssueReadContext(client, actor, (ctx) =>
            issueReader
              .forContext(ctx)
              .materialFollowups(project.id, [
                ...new Set(
                  command.records.flatMap((r) =>
                    r.issueId ? [r.issueId] : [],
                  ),
                ),
              ]),
          );
          let changed = false;
          for (const record of command.records) {
            const row = rows.find(
              (r) =>
                r.businessDate === record.sourceBusinessDate &&
                r.revisionNumber === record.revisionNumber,
            );
            const existing = before.find(
              (a) => a.useFactId === record.useFactId,
            );
            const currentActivity = row?.facts.activities?.find(
              (a) => a.use?.id === record.useFactId,
            );
            const activity = currentActivity ?? existing?.sourceActivity;
            if (!row || !activity || !activity.use)
              throw new InvalidReportInput('material.source');
            const quantity =
              activity.use.state === 'declared'
                ? dec(activity.use.actualQuantity)
                : null;
            const foreign = await client.query(
              `SELECT id FROM "MaterialUseAdmission" WHERE "orgId"=$1 AND "useFactId"=$2 AND "scopeId"<>$3`,
              [actor.orgId, record.useFactId, scope.id],
            );
            if (foreign.rowCount)
              throw new InvalidReportInput('material.scope');
            if (
              existing &&
              existing.sourceBusinessDate !== record.sourceBusinessDate
            )
              throw new InvalidReportInput('material.sourceDate');
            const reversalOnly =
              (!currentActivity ||
                activity.use.state === 'pending' ||
                !matches(activity, scope)) &&
              existing?.movementKind === 'use';
            if (
              (!matches(activity, scope) || quantity === null) &&
              !reversalOnly
            )
              throw new InvalidReportInput('material.quantity');
            const rule = materialUseDifference(activity);
            const issue = linked.find((i) => i.id === record.issueId);
            if (
              !reversalOnly &&
              rule.followupRequired &&
              !validFollowup(issue, activity)
            )
              throw new InvalidReportInput('material.followup');
            if (record.issueId) {
              if (
                !issue ||
                issue.workItemKey !== activity.workItemKey ||
                !issue.ownerPersonId ||
                !issue.dueOn
              )
                throw new InvalidReportInput('material.followup');
              if (record.dueAt) {
                const due = new Intl.DateTimeFormat('en-CA', {
                  timeZone: project.timezone,
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                }).format(new Date(record.dueAt));
                if (due !== issue.dueOn)
                  throw new InvalidReportInput('material.dueAt');
              }
            }
            const same =
              !reversalOnly &&
              existing?.movementKind === 'use' &&
              quantity !== null &&
              dec(existing.quantity) === quantity;
            if (
              same &&
              existing.sourceRevisionId === row.revisionId &&
              existing.issueId === record.issueId
            )
              continue;
            let movementId = existing?.movementId;
            if (existing?.movementKind === 'use' && !same)
              movementId = await this.movement(
                client,
                actor,
                scope.id,
                scope.version + 1,
                'reversal',
                decText(dec(existing.quantity)!),
                record.sourceBusinessDate,
                row.revisionId,
                record.useFactId,
                existing.movementId,
                'Explicit reversal of prior declaration; original retained',
              );
            if (!same && !reversalOnly)
              movementId = await this.movement(
                client,
                actor,
                scope.id,
                scope.version + 1,
                'use',
                decText(-quantity!),
                record.sourceBusinessDate,
                row.revisionId,
                record.useFactId,
                null,
                'Admitted from reporter declaration; not independently verified',
              );
            await client.query(
              `INSERT INTO "MaterialUseAdmission"(id,"orgId","scopeId","useFactId","sourceBusinessDate","sourceRevisionId","movementId","issueId","dueAt","updatedBy") VALUES($1,$2,$3,$4,$5::date,$6,$7,$8,$9,$10) ON CONFLICT ("orgId","useFactId") DO UPDATE SET "sourceRevisionId"=excluded."sourceRevisionId","movementId"=excluded."movementId","issueId"=excluded."issueId","dueAt"=NULL,version="MaterialUseAdmission".version+1,"updatedAt"=clock_timestamp(),"updatedBy"=excluded."updatedBy"`,
              [
                randomUUID(),
                actor.orgId,
                scope.id,
                record.useFactId,
                record.sourceBusinessDate,
                row.revisionId,
                movementId,
                record.issueId,
                null, // Legacy command dueAt is validated only; Issue owns the current deadline.
                actor.accountId,
              ],
            );
            changed = true;
          }
          if (changed)
            await client.query(
              `UPDATE "MaterialQuantityScope" SET version=version+1,"updatedBy"=$3 WHERE "orgId"=$1 AND id=$2`,
              [actor.orgId, scope.id, actor.accountId],
            );
          const currentScope = {
            ...scope,
            version: scope.version + (changed ? 1 : 0),
          };
          const after = (
            await scopeView(client, actor, currentScope, command.businessDate)
          ).current;
          await audit(
            client,
            actor,
            {
              type: 'MATERIAL_QUANTITY_SCOPE',
              id: scope.id,
              version: currentScope.version,
            },
            'MATERIAL_USE_ADMIT',
            'Explicit batch admission, not independent verification',
            before,
            { records: command.records, projection: after },
            command.clientMutationId,
          );
          return {
            scopeId: scope.id,
            version: currentScope.version,
            projection: after,
          };
        },
      );
    });
  }
  private async movement(
    client: PoolClient,
    actor: Actor,
    scopeId: string,
    sequence: number,
    kind: string,
    quantity: string,
    businessDate: string,
    sourceRevisionId: string | null,
    useFactId: string | null,
    reversesId: string | null,
    basis: string,
  ) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO "MaterialQuantityMovement"(id,"orgId","scopeId",sequence,kind,quantity,"businessDate","sourceRevisionId","useFactId","reversesId",basis,"actorAccountId","actorPersonId") VALUES($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11,$12,$13)`,
      [
        id,
        actor.orgId,
        scopeId,
        sequence,
        kind,
        quantity,
        businessDate,
        sourceRevisionId,
        useFactId,
        reversesId,
        basis,
        actor.accountId,
        actor.personId,
      ],
    );
    return id;
  }
}
