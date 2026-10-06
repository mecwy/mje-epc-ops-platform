/**
 * Completion review ports. A target references an existing foreman revision/item; it does
 * not create another quantity fact. Adoption, report completeness, quality and billing
 * remain separate. These ports are not HTTP routes or grants of runtime authority.
 */
import {
  InvalidReportInput,
  date,
  id,
  itemKey,
  oneOf,
  str,
  version,
} from './parse.js';
import { reported } from './report.js';
import { reportObject } from './report-source.js';

export interface CompletionReviewTargetDto {
  projectId: string;
  businessDate: string;
  crewId: string;
  foremanRevisionId: string;
  itemKey: string;
}

/** C05 owns this versioned association set. An item-only photo link is not this basis. */
export interface CompletionEvidenceBasisDto {
  linkSetId: string;
  version: number;
}

export const COMPLETION_REVIEW_DECISIONS = [
  'CONFIRM_SCOPE',
  'INCONCLUSIVE',
  'RETURN',
] as const;
export type CompletionReviewDecisionDto =
  (typeof COMPLETION_REVIEW_DECISIONS)[number];
export type CompletionReviewCoverageDto =
  { kind: 'WHOLE' } | { kind: 'PARTIAL'; scopeRef: string; qty: string };

interface ReviewCommandBase {
  schemaVersion: 1;
  clientMutationId: string;
  target: CompletionReviewTargetDto;
  /** Latest crew declaration number, not the review event sequence. */
  expectedRevision: number;
  /** Review event sequence for this exact revision/item; zero before its first event. */
  expectedVersion: number;
  reason: string;
  method: string;
  limitations: string;
}
export type ReviewForemanCommand = ReviewCommandBase &
  (
    | {
        decision: 'CONFIRM_SCOPE';
        coverage: CompletionReviewCoverageDto;
        evidenceBasis: CompletionEvidenceBasisDto;
      }
    | {
        decision: 'INCONCLUSIVE' | 'RETURN';
        coverage: null;
        evidenceBasis: CompletionEvidenceBasisDto | null;
      }
  );

/** Frozen, authorized C05 read result; READY means evidence available, not fact confirmed. */
export interface CompletionEvidenceDto {
  target: CompletionReviewTargetDto;
  basis: CompletionEvidenceBasisDto;
  state: 'MISSING' | 'PARTIAL' | 'READY' | 'UNCONFIRMED_SCOPE';
  coverage: {
    scopeRef: string;
    /** Explicit containment reference, never inferred from a shared item name. */
    withinScopeRef: string;
    qty: string;
    unit: string;
  } | null;
  photos: readonly {
    photoId: string;
    photoVersion: number;
    linkId: string;
  }[];
}

/** Judgment quantity only. The declaration remains at target.foremanRevisionId/itemKey. */
export interface CompletionReviewEventDto {
  id: string;
  target: CompletionReviewTargetDto;
  version: number;
  decision: CompletionReviewDecisionDto;
  confirmedQty: string | null;
  scopeRef: string | null;
  unit: string | null;
  evidenceBasis: CompletionEvidenceBasisDto | null;
  reason: string;
  method: string;
  limitations: string;
}

export interface CompletionReviewStateDto {
  target: CompletionReviewTargetDto;
  status:
    | 'NOT_CHECKED'
    | 'REVIEW_REQUIRED'
    | 'CONFIRMED_SCOPE'
    | 'INCONCLUSIVE'
    | 'RETURNED';
  coverage: 'NONE' | 'PARTIAL' | 'FULL';
  confirmedQty: string | null;
  unit: string | null;
  eventId: string | null;
  reviewVersion: number;
}

function text(v: unknown, field: string, required: boolean): string {
  const value = str(v, field, 500).trim();
  if (required && value === '') throw new InvalidReportInput(field);
  return value;
}

export function parseCompletionReviewTarget(
  v: unknown,
): CompletionReviewTargetDto {
  const o = reportObject(
    v,
    ['projectId', 'businessDate', 'crewId', 'foremanRevisionId', 'itemKey'],
    'target',
  );
  return {
    projectId: id(o['projectId'], 'target.projectId'),
    businessDate: date(o['businessDate'], 'target.businessDate'),
    crewId: id(o['crewId'], 'target.crewId'),
    foremanRevisionId: id(o['foremanRevisionId'], 'target.foremanRevisionId'),
    itemKey: itemKey(o['itemKey'], 'target.itemKey'),
  };
}

export function parseCompletionEvidenceBasis(
  v: unknown,
): CompletionEvidenceBasisDto {
  const o = reportObject(v, ['linkSetId', 'version'], 'evidenceBasis');
  const n = version(o['version'], 'evidenceBasis.version');
  if (n === 0) throw new InvalidReportInput('evidenceBasis.version');
  return {
    linkSetId: id(o['linkSetId'], 'evidenceBasis.linkSetId'),
    version: n,
  };
}

function coverage(v: unknown): CompletionReviewCoverageDto {
  const kind = oneOf(
    reportObject(v, ['kind', 'scopeRef', 'qty'], 'coverage')['kind'],
    ['WHOLE', 'PARTIAL'] as const,
    'coverage.kind',
  );
  if (kind === 'WHOLE') {
    reportObject(v, ['kind'], 'coverage');
    return { kind };
  }
  const o = reportObject(v, ['kind', 'scopeRef', 'qty'], 'coverage');
  const qty = reported(o['qty'], 'coverage.qty');
  if (qty === '' || qty === 'unknown' || qty === 'na')
    throw new InvalidReportInput('coverage.qty');
  return { kind, scopeRef: id(o['scopeRef'], 'coverage.scopeRef'), qty };
}

/** Strict at every nesting level. Actor/org/role/authority never come from the client. */
export function parseReviewForemanCommand(v: unknown): ReviewForemanCommand {
  const o = reportObject(
    v,
    [
      'schemaVersion',
      'clientMutationId',
      'target',
      'expectedRevision',
      'expectedVersion',
      'decision',
      'coverage',
      'evidenceBasis',
      'reason',
      'method',
      'limitations',
    ],
    'command',
  );
  if (o['schemaVersion'] !== 1) throw new InvalidReportInput('schemaVersion');
  const decision = oneOf(
    o['decision'],
    COMPLETION_REVIEW_DECISIONS,
    'decision',
  );
  const expectedRevision = version(o['expectedRevision'], 'expectedRevision');
  if (expectedRevision === 0) throw new InvalidReportInput('expectedRevision');
  const base: ReviewCommandBase = {
    schemaVersion: 1,
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    target: parseCompletionReviewTarget(o['target']),
    expectedRevision,
    expectedVersion: version(o['expectedVersion'], 'expectedVersion'),
    reason: text(o['reason'], 'reason', decision !== 'CONFIRM_SCOPE'),
    method: text(o['method'], 'method', decision === 'CONFIRM_SCOPE'),
    limitations: text(o['limitations'], 'limitations', false),
  };
  if (decision === 'CONFIRM_SCOPE')
    return {
      ...base,
      decision,
      coverage: coverage(o['coverage']),
      evidenceBasis: parseCompletionEvidenceBasis(o['evidenceBasis']),
    };
  if (o['coverage'] !== null) throw new InvalidReportInput('coverage');
  return {
    ...base,
    decision,
    coverage: null,
    evidenceBasis:
      o['evidenceBasis'] === null
        ? null
        : parseCompletionEvidenceBasis(o['evidenceBasis']),
  };
}
