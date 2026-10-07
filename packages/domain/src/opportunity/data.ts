/** Private storage types. Every stored command is reparsed before projection. */
import type { PoolClient } from 'pg';
import {
  parseOpportunityFacts,
  parseCreateOpportunity,
  parseUpdateOpportunity,
  parseRequestOpportunityDecision,
  parseRecordOpportunityDecision,
  type OpportunityFacts,
  type CreateOpportunityCommand,
  type UpdateOpportunityCommand,
  type RequestOpportunityDecisionCommand,
  type RecordOpportunityDecisionCommand,
  type OpportunitySourceDto,
  type OpportunityNextStepDto,
  type OpportunityDecisionState,
} from '@mje/contracts';
import { initialDecision } from './rules.js';
/** Single owned eligibility exit used by lookup, binding and historical projections. */
export const eligibleOpportunitySource = (org: string, document: string) =>
  `opportunity_source_is_eligible(${org},${document})`;
interface BaseRecord {
  id: string;
  n: number;
  facts: OpportunityFacts;
  recordedAt: string;
  recordedByAccountId: string;
  recordedByPersonId: string;
  sources: OpportunitySourceDto[];
  sourcesEligible: boolean;
}
export type StoredRecord = BaseRecord &
  (
    | { kind: 'CREATE'; command: CreateOpportunityCommand }
    | { kind: 'UPDATE'; command: UpdateOpportunityCommand }
    | { kind: 'REQUEST'; command: RequestOpportunityDecisionCommand }
    | { kind: 'DECISION'; command: RecordOpportunityDecisionCommand }
  );
export interface StoredOpportunity {
  id: string;
  code: string;
  version: number;
  records: StoredRecord[];
}
export async function stored(
  c: PoolClient,
  org: string,
  id: string,
): Promise<StoredOpportunity | null> {
  const row = (
    await c.query<{ id: string; code: string; version: number }>(
      'SELECT id,code,version FROM "Opportunity" WHERE "orgId"=$1 AND id=$2',
      [org, id],
    )
  ).rows[0];
  if (!row) return null;
  const rows = (
    await c.query<{
      id: string;
      n: number;
      kind: string;
      facts: unknown;
      payload: unknown;
      recordedAt: Date;
      recordedByAccountId: string;
      recordedByPersonId: string;
    }>(
      `SELECT id,n,kind,facts,payload,"recordedAt","recordedByAccountId","recordedByPersonId" FROM "OpportunityRecord" WHERE "orgId"=$1 AND "opportunityId"=$2 ORDER BY n`,
      [org, id],
    )
  ).rows;
  if (!rows.length) return null; // Legacy identity has no DG06 facts; never invent a lead.
  const sources = (
    await c.query<
      OpportunitySourceDto & { recordId: string; eligible: boolean }
    >(
      `SELECT s."recordId",s."sourceDocumentId",s.reference,s.location,d.filename,d.sha256,(s."sourceDocumentId" IS NULL OR ${eligibleOpportunitySource('$1', 's."sourceDocumentId"')}) AS eligible FROM "OpportunityRecordSource" s LEFT JOIN "SourceDocument" d ON d."orgId"=s."orgId" AND d.id=s."sourceDocumentId" WHERE s."orgId"=$1 AND s."recordId"=ANY($2::uuid[]) ORDER BY s.id`,
      [org, rows.map((x) => x.id)],
    )
  ).rows;
  const records: StoredRecord[] = rows.map((r) => {
    const base: BaseRecord = {
      id: r.id,
      n: r.n,
      facts: parseOpportunityFacts(r.facts),
      recordedAt: r.recordedAt.toISOString(),
      recordedByAccountId: r.recordedByAccountId,
      recordedByPersonId: r.recordedByPersonId,
      sourcesEligible: sources
        .filter((s) => s.recordId === r.id)
        .every((s) => s.eligible),
      sources: sources
        .filter((s) => s.recordId === r.id)
        .map((s) => ({
          sourceDocumentId: s.sourceDocumentId,
          reference: s.reference,
          location: s.location,
          filename: s.filename,
          sha256: s.sha256,
        })),
    };
    switch (r.kind) {
      case 'CREATE':
        return {
          ...base,
          kind: 'CREATE',
          command: parseCreateOpportunity(r.payload),
        };
      case 'UPDATE':
        return {
          ...base,
          kind: 'UPDATE',
          command: parseUpdateOpportunity(r.payload),
        };
      case 'REQUEST':
        return {
          ...base,
          kind: 'REQUEST',
          command: parseRequestOpportunityDecision(r.payload),
        };
      case 'DECISION':
        return {
          ...base,
          kind: 'DECISION',
          command: parseRecordOpportunityDecision(r.payload),
        };
      default:
        throw new Error('invalid opportunity record');
    }
  });
  // A concurrent commit between the identity and event reads must not pair newer facts with
  // an older baseline. The immutable event sequence is the authoritative captured version.
  return { ...row, version: records.at(-1)!.n, records };
}
export function state(row: StoredOpportunity) {
  let step: OpportunityNextStepDto | null = null,
    request: Extract<StoredRecord, { kind: 'REQUEST' }> | null = null,
    decision: OpportunityDecisionState = initialDecision(),
    decisionVersion = 0;
  const steps: OpportunityNextStepDto[] = [];
  for (const r of row.records) {
    if (r.kind === 'UPDATE' && r.command.nextStep.mode !== 'KEEP') {
      if (step && r.command.nextStep.mode === 'COMPLETE_AND_ADD') {
        step.completed = true;
      }
      step = {
        ...r.command.nextStep.next,
        createdAt: r.recordedAt,
        completed: false,
      };
      steps.push(step);
    }
    if (r.kind === 'REQUEST') request = r;
    if (r.kind === 'DECISION') {
      decision = r.command.decision;
      decisionVersion++;
      request = null;
    }
  }
  return {
    facts: row.records.at(-1)!.facts,
    step,
    steps,
    request,
    decision,
    decisionVersion,
  };
}
