import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  parseReviewForemanCommand,
  type ReviewForemanCommand,
} from '@mje/contracts';
import {
  parseManagerReviewScope,
  type ManagerReviewScopeDto,
  type ManagerReviewWriteResultDto,
} from '@mje/contracts';
import type { Identity } from './alpha-store.js';
import {
  audit,
  idempotent,
  inTransaction,
  lockReportDay,
  projectAccess,
  ReportError,
  type Actor,
} from './store-kit.js';
import { nextSeq } from './checkin-store.js';
import {
  planCompletionReview,
  reviewIndependent,
  reviewAuthorityGrant,
  type CompletionDeclaration,
  type CompletionEvidence,
  type CompletionTarget,
  type ReviewAuthority,
  type ReviewIndependence,
} from './manager-review-rules.js';
import { ManagerReviewError, reviewSource } from './manager-review-reader.js';

export interface ReviewServerPorts {
  /** Resolve at actor.decidedAt under the transaction's relevant grant locks; job title is not a grant. */
  resolveAuthority(
    client: PoolClient,
    actor: Actor,
    scope: ManagerReviewScopeDto,
  ): Promise<ReviewAuthority>;
  resolveIndependence(
    client: PoolClient,
    actor: Actor,
    declaration: CompletionDeclaration,
  ): Promise<ReviewIndependence>;
  evidenceFor(
    client: PoolClient,
    actor: Actor,
    target: CompletionTarget,
  ): Promise<CompletionEvidence | null>;
  /** Existing foreman rows have no frozen unit/scope or author identity proof. Never infer these from a photo or current catalog. */
  sourceContextFor(
    client: PoolClient,
    actor: Actor,
    target: CompletionTarget,
    reportedByPersonId: string,
  ): Promise<{
    unit: string | null;
    scopeRef: string | null;
    scopeStatus: 'CONFIRMED' | 'PENDING';
    reportedIdentityResolved: boolean;
    changedByPersonIds: readonly string[];
  }>;
}
export const DENY_REVIEW_PORTS: ReviewServerPorts = {
  resolveAuthority: async (_c, a) => ({
    orgId: a.orgId,
    accountId: a.accountId,
    personId: a.personId,
    active: true,
    identityResolved: false,
    policyRef: null,
    decidedAt: new Date(a.decidedAt).toISOString(),
    grants: [],
  }),
  resolveIndependence: async () => ({
    status: 'UNKNOWN',
    policyRef: null,
    partiesComplete: false,
    partyPersonIds: [],
  }),
  evidenceFor: async () => null,
  sourceContextFor: async () => ({
    unit: null,
    scopeRef: null,
    scopeStatus: 'PENDING',
    reportedIdentityResolved: false,
    changedByPersonIds: [],
  }),
};

/** Replays must enforce natural-person independence too, without running new-write CAS/evidence gates.
 * The pure reviewIndependent rule is shared with new-write planning; replay never reruns CAS
 * or evidence-cut checks. Quantity/scope/confirmation policy remains planCompletionReview.
 */
export function reviewReplayAdmission(
  actor: Actor,
  authority: ReviewAuthority,
  d: CompletionDeclaration,
  i: ReviewIndependence,
): void {
  if (
    authority.orgId !== actor.orgId ||
    authority.accountId !== actor.accountId ||
    authority.personId !== actor.personId
  )
    throw new ManagerReviewError('FORBIDDEN');
  const admission = reviewIndependent({
    authority,
    declaration: d,
    independence: i,
  });
  if (!admission.ok) throw new ManagerReviewError(admission.code);
}

export class ManagerReviewStore {
  constructor(
    private readonly pool: Pool,
    private readonly ports: ReviewServerPorts = DENY_REVIEW_PORTS,
  ) {}
  async write(
    identity: Identity,
    input: ReviewForemanCommand,
  ): Promise<ManagerReviewWriteResultDto> {
    const command = parseReviewForemanCommand(input);
    const scope = parseManagerReviewScope({
      projectId: command.target.projectId,
      businessDate: command.target.businessDate,
      crewId: command.target.crewId,
      itemKey: command.target.itemKey,
    });
    return inTransaction(this.pool, identity, async (client, actor) => {
      const { access } = await projectAccess(client, actor, scope.projectId);
      if (access !== 'write') throw new ReportError('READ_ONLY');
      const authority = await this.ports.resolveAuthority(client, actor, scope);
      if (
        authority.orgId !== actor.orgId ||
        authority.accountId !== actor.accountId ||
        authority.personId !== actor.personId
      )
        throw new ManagerReviewError('FORBIDDEN');
      const permitted = reviewAuthorityGrant(
        authority,
        actor.orgId,
        command.target,
        command.decision,
      );
      if (!permitted.ok) throw new ManagerReviewError(permitted.code);
      // Exact immutable source is used for replay independence even if a newer declaration exists.
      const original = await reviewSource(
        client,
        actor,
        scope,
        this.ports,
        command.target.foremanRevisionId,
      );
      const independence = await this.ports.resolveIndependence(
        client,
        actor,
        original.declaration,
      );
      reviewReplayAdmission(
        actor,
        authority,
        original.declaration,
        independence,
      );
      return idempotent(
        client,
        actor,
        'MANAGER_REVIEW',
        command.clientMutationId,
        command,
        async () => {
          await lockReportDay(
            client,
            actor.orgId,
            scope.projectId,
            scope.businessDate,
          );
          const reused = await client.query(
            'SELECT 1 FROM "ManagerReviewEvent" WHERE "orgId"=$1 AND "clientMutationId"=$2',
            [actor.orgId, command.clientMutationId],
          );
          if (reused.rowCount)
            throw new ManagerReviewError('IDEMPOTENCY_KEY_REUSED');
          const current = await reviewSource(
            client,
            actor,
            scope,
            this.ports,
            null,
          );
          const d = current.declaration;
          const nowIndependence = await this.ports.resolveIndependence(
            client,
            actor,
            d,
          );
          reviewReplayAdmission(actor, authority, d, nowIndependence);
          const evidence = await this.ports.evidenceFor(
            client,
            actor,
            d.target,
          );
          const version = await client.query<{ version: number }>(
            `SELECT COALESCE(MAX(version),0)::integer AS version FROM "ManagerReviewEvent"
          WHERE "orgId"=$1 AND "projectId"=$2 AND "foremanRevisionId"=$3 AND "itemKey"=$4`,
            [
              actor.orgId,
              scope.projectId,
              d.target.foremanRevisionId,
              scope.itemKey,
            ],
          );
          const planned = planCompletionReview(command, {
            authority,
            declaration: d,
            independence: nowIndependence,
            evidence,
            reviewVersion: version.rows[0]!.version,
          });
          if (!planned.ok) throw new ManagerReviewError(planned.code);
          const plan = planned.value;
          const eventId = randomUUID();
          const daySeq = await nextSeq(
            client,
            actor.orgId,
            scope.projectId,
            scope.businessDate,
          );
          await client.query(
            `INSERT INTO "ManagerReviewEvent" (id,"orgId","projectId","crewId","foremanReportId","foremanRevisionId","itemKey","businessDate","siteTimezone",version,decision,"coverageKind","confirmedQty",unit,"scopeRef","evidenceBasis",reason,method,limitations,"authorityGrantId","authorityPolicyRef","independencePolicyRef","actorAccountId","actorPersonId","clientMutationId","daySeq")
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,$12,$13::numeric,$14,$15,$16::jsonb,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
            [
              eventId,
              actor.orgId,
              scope.projectId,
              scope.crewId,
              current.reportId,
              d.target.foremanRevisionId,
              scope.itemKey,
              scope.businessDate,
              current.siteTimezone,
              plan.version,
              plan.decision,
              command.coverage?.kind ?? null,
              plan.confirmedQty,
              plan.unit,
              plan.scopeRef,
              plan.evidenceBasis ? JSON.stringify(plan.evidenceBasis) : null,
              plan.reason,
              plan.method,
              plan.limitations,
              plan.authorityGrantId,
              authority.policyRef,
              nowIndependence.policyRef,
              actor.accountId,
              actor.personId,
              command.clientMutationId,
              daySeq,
            ],
          );
          await audit(
            client,
            actor,
            { type: 'ManagerReviewEvent', id: eventId, version: plan.version },
            'MANAGER_REVIEW',
            plan.reason,
            null,
            {
              target: plan.target,
              decision: plan.decision,
              coverageKind: command.coverage?.kind ?? null,
              confirmedQty: plan.confirmedQty,
              scopeRef: plan.scopeRef,
              unit: plan.unit,
              evidenceBasis: plan.evidenceBasis,
              authorityGrantId: plan.authorityGrantId,
            },
            command.clientMutationId,
          );
          return { eventId, reviewVersion: plan.version };
        },
      );
    });
  }
}
