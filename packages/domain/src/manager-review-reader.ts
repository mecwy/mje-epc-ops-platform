import type { EvidenceTarget } from '@mje/contracts';
import type { EvidenceDeclarationSource } from './business-evidence-store.js';
import type { PoolClient } from 'pg';
import type {
  ManagerReviewScopeDto,
  ManagerReviewReadDto,
} from '@mje/contracts';
import type {
  CompletionReviewTargetDto,
  ForemanReportRowDto,
} from '@mje/contracts';
import {
  completionReviewState,
  reviewAuthorityGrant,
  type CompletionDeclaration,
  type CompletionReviewEvent,
  type CompletionTarget,
  type EvidenceBasis,
} from './manager-review-rules.js';
import { projectAccess, type Actor } from './store-kit.js';
import {
  DENY_REVIEW_PORTS,
  reviewReplayAdmission,
  type ReviewServerPorts,
} from './manager-review-store.js';

export class ManagerReviewError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export interface ReviewSource {
  declaration: CompletionDeclaration;
  reportId: string;
  siteTimezone: string;
  crewLabel: string;
  itemLabel: string;
}
/** Actual persisted source, never a client declaration. Null/unknown scope is preserved. */
export async function reviewSource(
  client: PoolClient,
  actor: Actor,
  scope: ManagerReviewScopeDto,
  ports: ReviewServerPorts,
  revisionId: string | null,
): Promise<ReviewSource> {
  const result = await client.query<{
    id: string;
    reportId: string;
    n: number;
    rows: ForemanReportRowDto[];
    byPersonId: string;
    siteTimezone: string;
    crewLabel: string;
  }>(
    `SELECT v.id,v."reportId",v.n,v.rows,v."byPersonId",v."siteTimezone",c.name AS "crewLabel"
    FROM "ForemanReport" h JOIN "ForemanReportRevision" v ON v."orgId"=h."orgId" AND v."projectId"=h."projectId" AND v."reportId"=h.id
    JOIN "Crew" c ON c."orgId"=h."orgId" AND c."projectId"=h."projectId" AND c.id=h."crewId"
    WHERE h."orgId"=$1 AND h."projectId"=$2 AND h."businessDate"=$3::date AND h."crewId"=$4
    AND (($5::uuid IS NULL AND v.n=h."currentN") OR v.id=$5::uuid)`,
    [
      actor.orgId,
      scope.projectId,
      scope.businessDate,
      scope.crewId,
      revisionId,
    ],
  );
  const row = result.rows[0];
  if (!row || result.rows.length !== 1)
    throw new ManagerReviewError('NOT_FOUND');
  const item = row.rows.find((r) => r.itemKey === scope.itemKey);
  if (!item) throw new ManagerReviewError('ITEM_NOT_FOUND');
  const target = { ...scope, foremanRevisionId: row.id };
  const sourceContext = await ports.sourceContextFor(
    client,
    actor,
    target,
    row.byPersonId,
  );
  return {
    declaration: {
      orgId: actor.orgId,
      target,
      revisionNumber: row.n,
      qty: item.qty,
      unit: sourceContext.unit,
      scopeRef: sourceContext.scopeRef,
      scopeStatus: sourceContext.scopeStatus,
      reportedByPersonId: row.byPersonId,
      reportedIdentityResolved: sourceContext.reportedIdentityResolved,
      changedByPersonIds: sourceContext.changedByPersonIds,
    },
    reportId: row.reportId,
    siteTimezone: row.siteTimezone,
    crewLabel: row.crewLabel,
    itemLabel: scope.itemKey,
  };
}

export async function reviewEvents(
  client: PoolClient,
  actor: Actor,
  scope: ManagerReviewScopeDto,
): Promise<CompletionReviewEvent[]> {
  const r = await client.query<
    CompletionReviewEvent & { eventTarget: CompletionReviewTargetDto }
  >(
    `SELECT id,"orgId",jsonb_build_object('projectId',"projectId",'businessDate',"businessDate"::text,'crewId',"crewId",'foremanRevisionId',"foremanRevisionId",'itemKey',"itemKey") AS "eventTarget",
     version,decision,trim_scale("confirmedQty")::text AS "confirmedQty","scopeRef",unit,"evidenceBasis",reason,method,limitations,
     "actorPersonId" AS "reviewerPersonId","actorAccountId" AS "reviewerAccountId","authorityGrantId"
     FROM "ManagerReviewEvent" WHERE "orgId"=$1 AND "projectId"=$2 AND "businessDate"=$3::date AND "crewId"=$4 AND "itemKey"=$5 ORDER BY version,id`,
    [
      actor.orgId,
      scope.projectId,
      scope.businessDate,
      scope.crewId,
      scope.itemKey,
    ],
  );
  return r.rows.map(({ eventTarget, ...event }) => ({
    ...event,
    target: eventTarget,
  }));
}

/** Called by the parent report reader inside its authorized transaction and shared day lock. */
export const managerReviewReader = {
  async read(
    client: PoolClient,
    actor: Actor,
    scope: ManagerReviewScopeDto,
    ports: ReviewServerPorts,
  ): Promise<ManagerReviewReadDto> {
    await projectAccess(client, actor, scope.projectId);
    const authority = await ports.resolveAuthority(client, actor, scope);
    if (
      authority.orgId !== actor.orgId ||
      authority.accountId !== actor.accountId ||
      authority.personId !== actor.personId
    )
      throw new ManagerReviewError('FORBIDDEN');
    const access = reviewAuthorityGrant(
      authority,
      actor.orgId,
      { ...scope, foremanRevisionId: '' },
      'READ_REVIEW',
    );
    if (!access.ok) throw new ManagerReviewError(access.code);
    const source = await reviewSource(client, actor, scope, ports, null);
    const d = source.declaration;
    const evidence = await ports.evidenceFor(client, actor, d.target);
    const events = await reviewEvents(client, actor, scope);
    const projected = completionReviewState(authority, d, evidence, events);
    if (!projected.ok) throw new ManagerReviewError(projected.code);
    const state = projected.value;
    const event = state.eventId
      ? (events.find((e) => e.id === state.eventId) ?? null)
      : null;
    const judgment = event
      ? {
          id: event.id,
          target: { ...event.target },
          version: event.version,
          decision: event.decision,
          confirmedQty: event.confirmedQty,
          unit: event.unit,
          scopeRef: event.scopeRef,
          evidenceBasis: event.evidenceBasis
            ? { ...event.evidenceBasis }
            : null,
          reason: event.reason,
          method: event.method,
          limitations: event.limitations,
        }
      : null;
    const publicEvidence = evidence
      ? {
          target: {
            projectId: evidence.target.projectId,
            businessDate: evidence.target.businessDate,
            crewId: evidence.target.crewId,
            foremanRevisionId: evidence.target.foremanRevisionId,
            itemKey: evidence.target.itemKey,
          },
          basis: {
            linkSetId: evidence.basis.linkSetId,
            version: evidence.basis.version,
          },
          state: evidence.state,
          coverage: evidence.coverage
            ? {
                scopeRef: evidence.coverage.scopeRef,
                withinScopeRef: evidence.coverage.withinScopeRef,
                qty: evidence.coverage.qty,
                unit: evidence.coverage.unit,
              }
            : null,
          photos: evidence.photos.map((p) => ({
            photoId: p.photoId,
            photoVersion: p.photoVersion,
            linkId: p.linkId,
          })),
        }
      : null;
    const independence = await ports.resolveIndependence(client, actor, d);
    let independent = true;
    try {
      reviewReplayAdmission(actor, authority, d, independence);
    } catch (error) {
      if (!(error instanceof ManagerReviewError)) throw error;
      independent = false;
    }
    const actions = independent
      ? (['RETURN', 'INCONCLUSIVE', 'CONFIRM_SCOPE'] as const).filter(
          (a) => reviewAuthorityGrant(authority, actor.orgId, d.target, a).ok,
        )
      : [];
    return {
      actorScopeKey: `${actor.orgId}:${actor.accountId}:${actor.personId}`,
      target: { ...d.target },
      revisionNumber: d.revisionNumber,
      reviewVersion: state.reviewVersion,
      declaredQty: d.qty,
      labels: {
        crew: source.crewLabel,
        item: source.itemLabel,
        scope: d.scopeRef,
      },
      unit: d.unit,
      scopeRef: d.scopeRef,
      capability: { basisRef: authority.policyRef, actions },
      evidence: publicEvidence,
      state,
      judgment,
    };
  },
};

/** A submitted report freezes the event identity/basis cut, never another quantity ledger. */
export interface ManagerReviewSnapshotCut {
  asOfSeq: number;
  events: {
    eventId: string;
    target: CompletionTarget;
    reviewVersion: number;
    evidenceBasis: EvidenceBasis | null;
  }[];
}
/** Report submit owns the original day gate before obtaining this same field sequence cut. */
export async function managerReviewSnapshotCut(
  client: PoolClient,
  orgId: string,
  projectId: string,
  businessDate: string,
  asOfSeq: number,
): Promise<ManagerReviewSnapshotCut> {
  if (!Number.isSafeInteger(asOfSeq) || asOfSeq < 0)
    throw new ManagerReviewError('REVIEW_HISTORY_CONFLICT');
  const result = await client.query<ManagerReviewSnapshotCut['events'][number]>(
    `SELECT id AS "eventId",jsonb_build_object('projectId',"projectId",'businessDate',"businessDate"::text,
      'crewId',"crewId",'foremanRevisionId',"foremanRevisionId",'itemKey',"itemKey") AS target,
      version AS "reviewVersion","evidenceBasis"
    FROM "ManagerReviewEvent" WHERE "orgId"=$1 AND "projectId"=$2 AND "businessDate"=$3::date
      AND "daySeq"<=$4 ORDER BY "daySeq",id`,
    [orgId, projectId, businessDate, asOfSeq],
  );
  return {
    asOfSeq,
    events: result.rows.map((row) => ({
      eventId: row.eventId,
      target: {
        projectId: row.target.projectId,
        businessDate: row.target.businessDate,
        crewId: row.target.crewId,
        foremanRevisionId: row.target.foremanRevisionId,
        itemKey: row.target.itemKey,
      },
      reviewVersion: row.reviewVersion,
      evidenceBasis: row.evidenceBasis
        ? {
            linkSetId: row.evidenceBasis.linkSetId,
            version: row.evidenceBasis.version,
          }
        : null,
    })),
  };
}

export async function readForemanEvidenceSource(
  client: PoolClient,
  actor: Actor,
  target: EvidenceTarget,
  sourceContextFor: ReviewServerPorts['sourceContextFor'] = DENY_REVIEW_PORTS.sourceContextFor,
): Promise<EvidenceDeclarationSource | null> {
  try {
    const source = await reviewSource(
      client,
      actor,
      target,
      { ...DENY_REVIEW_PORTS, sourceContextFor },
      target.foremanRevisionId,
    );
    const head = await client.query<{ currentN: number }>(
      `SELECT "currentN" FROM "ForemanReport" WHERE "orgId"=$1 AND "projectId"=$2 AND id=$3 AND "crewId"=$4 AND "businessDate"=$5::date`,
      [
        actor.orgId,
        target.projectId,
        source.reportId,
        target.crewId,
        target.businessDate,
      ],
    );
    const n = head.rows[0]?.currentN;
    if (
      head.rows.length !== 1 ||
      !Number.isSafeInteger(n) ||
      n! < source.declaration.revisionNumber
    )
      throw new ManagerReviewError('SOURCE_UNAVAILABLE');
    return {
      reportId: source.reportId,
      declaration: source.declaration,
      currentRevisionNumber: n!,
    };
  } catch (error) {
    if (
      error instanceof ManagerReviewError &&
      (error.code === 'NOT_FOUND' || error.code === 'ITEM_NOT_FOUND')
    )
      return null;
    throw error;
  }
}
