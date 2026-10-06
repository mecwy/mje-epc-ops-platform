/**
 * Pure completion review admission/projection. The future server adapter must supply
 * transaction-consistent authority, declarations, parties and C05 evidence. No SQL, HTTP,
 * persistence, role inference, date-window expansion or second declaration write source.
 * Domain inputs deliberately omit transport schema/key fields; the contract adapter maps
 * structurally to these inputs without requiring unleased package export changes.
 */
import { isRealTimestamp } from '@mje/contracts';
import { dec, decText } from './report-rules.js';

export interface CompletionTarget {
  readonly projectId: string;
  readonly businessDate: string;
  readonly crewId: string;
  readonly foremanRevisionId: string;
  readonly itemKey: string;
}
export interface EvidenceBasis {
  readonly linkSetId: string;
  readonly version: number;
}
export type ReviewDecision = 'CONFIRM_SCOPE' | 'INCONCLUSIVE' | 'RETURN';
export type ReviewAction = ReviewDecision | 'READ_REVIEW';
export interface ReviewScopeGrant {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string;
  /** Null explicitly grants all crews/items in this project, not all projects. */
  readonly crewId: string | null;
  readonly itemKey: string | null;
  readonly actions: readonly ReviewAction[];
  readonly validFrom: string;
  readonly validUntil: string | null;
}
/** Verified server inputs only. A job title or canWrite is not a review grant. */
export interface ReviewAuthority {
  readonly orgId: string;
  readonly accountId: string;
  readonly personId: string | null;
  readonly active: boolean;
  readonly identityResolved: boolean;
  readonly policyRef: string | null;
  readonly decidedAt: string;
  readonly grants: readonly ReviewScopeGrant[];
}
export interface CompletionDeclaration {
  readonly orgId: string;
  readonly target: CompletionTarget;
  readonly revisionNumber: number;
  readonly qty: string;
  readonly unit: string | null;
  readonly scopeRef: string | null;
  readonly scopeStatus: 'CONFIRMED' | 'PENDING';
  readonly reportedByPersonId: string | null;
  /** A provisional Person ID alone does not establish the source claimant's identity. */
  readonly reportedIdentityResolved: boolean;
  /** Actual proxy/authors of this transaction, not everyone with the same employer. */
  readonly changedByPersonIds: readonly string[];
}
export interface ReviewIndependence {
  readonly status: 'CLEAR' | 'CONFLICT' | 'UNKNOWN';
  readonly policyRef: string | null;
  readonly partiesComplete: boolean;
  /** Resolved natural persons involved in the transaction, including known interests. */
  readonly partyPersonIds: readonly string[];
}
/** C05 read on the same transaction/cut as the declaration and review event sequence. */
export interface CompletionEvidence {
  readonly orgId: string;
  readonly target: CompletionTarget;
  readonly basis: EvidenceBasis;
  readonly state: 'MISSING' | 'PARTIAL' | 'READY' | 'UNCONFIRMED_SCOPE';
  readonly coverage: {
    readonly scopeRef: string;
    readonly withinScopeRef: string;
    readonly qty: string;
    readonly unit: string;
  } | null;
  readonly photos: readonly {
    readonly photoId: string;
    readonly photoVersion: number;
    readonly linkId: string;
  }[];
}
export interface CompletionReviewRequest {
  readonly target: CompletionTarget;
  readonly expectedRevision: number;
  readonly expectedVersion: number;
  readonly decision: ReviewDecision;
  readonly coverage:
    | { readonly kind: 'WHOLE' }
    | {
        readonly kind: 'PARTIAL';
        readonly scopeRef: string;
        readonly qty: string;
      }
    | null;
  readonly evidenceBasis: EvidenceBasis | null;
  readonly reason: string;
  readonly method: string;
  readonly limitations: string;
}
export interface CompletionReviewContext {
  readonly authority: ReviewAuthority;
  readonly declaration: CompletionDeclaration;
  readonly independence: ReviewIndependence;
  readonly evidence: CompletionEvidence | null;
  readonly reviewVersion: number;
}

export type ReviewRuleCode =
  | 'FORBIDDEN'
  | 'IDENTITY_UNKNOWN'
  | 'REVIEW_AUTHORITY_UNKNOWN'
  | 'SELF_REVIEW'
  | 'REVIEW_CONFLICT'
  | 'INDEPENDENCE_UNKNOWN'
  | 'TARGET_CHANGED'
  | 'FOREMAN_REVISION_CHANGED'
  | 'REVIEW_VERSION_CONFLICT'
  | 'REVIEW_VERSION_EXHAUSTED'
  | 'EVIDENCE_CHANGED'
  | 'EVIDENCE_REQUIRED'
  | 'SCOPE_UNCONFIRMED'
  | 'QUANTITY_UNKNOWN'
  | 'UNIT_MISMATCH'
  | 'COVERAGE_INVALID'
  | 'REASON_REQUIRED'
  | 'METHOD_REQUIRED'
  | 'REVIEW_HISTORY_CONFLICT';
export type ReviewRuleResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: ReviewRuleCode;
    };
const refused = (
  code: ReviewRuleCode,
): { ok: false; code: ReviewRuleCode } => ({ ok: false, code });

function sameScope(a: CompletionTarget, b: CompletionTarget): boolean {
  return (
    a.projectId === b.projectId &&
    a.businessDate === b.businessDate &&
    a.crewId === b.crewId &&
    a.itemKey === b.itemKey
  );
}
export function sameCompletionTarget(
  a: CompletionTarget,
  b: CompletionTarget,
): boolean {
  return sameScope(a, b) && a.foremanRevisionId === b.foremanRevisionId;
}
export function sameEvidenceBasis(a: EvidenceBasis, b: EvidenceBasis): boolean {
  return a.linkSetId === b.linkSetId && a.version === b.version;
}

/** Check even for an empty result/history. Replay adapters must call this before lookup. */
export function reviewAuthorityGrant(
  a: ReviewAuthority,
  orgId: string,
  target: CompletionTarget,
  action: ReviewAction,
): ReviewRuleResult<string> {
  if (!a.active || a.orgId !== orgId) return refused('FORBIDDEN');
  if (!isRealTimestamp(a.decidedAt)) return refused('REVIEW_AUTHORITY_UNKNOWN');
  const at = Date.parse(a.decidedAt);
  const grant = a.grants.find(
    (g) =>
      g.orgId === orgId &&
      g.projectId === target.projectId &&
      (g.crewId === null || g.crewId === target.crewId) &&
      (g.itemKey === null || g.itemKey === target.itemKey) &&
      g.actions.includes(action) &&
      isRealTimestamp(g.validFrom) &&
      Date.parse(g.validFrom) <= at &&
      (g.validUntil === null ||
        (isRealTimestamp(g.validUntil) && at < Date.parse(g.validUntil))),
  );
  if (!grant) return refused('FORBIDDEN');
  if (!a.policyRef?.trim() || !grant.id.trim())
    return refused('REVIEW_AUTHORITY_UNKNOWN');
  return { ok: true, value: grant.id };
}

function independent(c: CompletionReviewContext): ReviewRuleResult<null> {
  const { authority: a, declaration: d, independence: i } = c;
  if (
    !a.identityResolved ||
    !a.personId?.trim() ||
    !d.reportedIdentityResolved ||
    !d.reportedByPersonId?.trim()
  )
    return refused('IDENTITY_UNKNOWN');
  if (
    a.personId === d.reportedByPersonId ||
    d.changedByPersonIds.includes(a.personId)
  )
    return refused('SELF_REVIEW');
  if (i.partyPersonIds.includes(a.personId) || i.status === 'CONFLICT')
    return refused('REVIEW_CONFLICT');
  if (i.status !== 'CLEAR' || !i.partiesComplete || !i.policyRef?.trim())
    return refused('INDEPENDENCE_UNKNOWN');
  return { ok: true, value: null };
}

function validCounter(n: number, minimum: number): boolean {
  return Number.isSafeInteger(n) && n >= minimum && n <= 1_000_000;
}

function usablePhotos(photos: CompletionEvidence['photos']): boolean {
  return (
    photos.length > 0 &&
    photos.every(
      (p) =>
        p.photoId.trim() !== '' &&
        p.linkId.trim() !== '' &&
        Number.isSafeInteger(p.photoVersion) &&
        p.photoVersion > 0,
    )
  );
}

export interface CompletionReviewPlan {
  readonly target: CompletionTarget;
  readonly version: number;
  readonly decision: ReviewDecision;
  readonly confirmedQty: string | null;
  readonly scopeRef: string | null;
  readonly unit: string | null;
  readonly evidenceBasis: EvidenceBasis | null;
  readonly reason: string;
  readonly method: string;
  readonly limitations: string;
  readonly reviewerPersonId: string;
  readonly reviewerAccountId: string;
  readonly authorityGrantId: string;
}

/** New event admission only; successful idempotent replay is a store responsibility. */
export function planCompletionReview(
  r: CompletionReviewRequest,
  c: CompletionReviewContext,
): ReviewRuleResult<CompletionReviewPlan> {
  const d = c.declaration;
  const grant = reviewAuthorityGrant(
    c.authority,
    d.orgId,
    r.target,
    r.decision,
  );
  if (!grant.ok) return grant;
  if (!sameCompletionTarget(r.target, d.target))
    return refused('TARGET_CHANGED');
  const independence = independent(c);
  if (!independence.ok) return independence;
  if (
    !validCounter(r.expectedRevision, 1) ||
    !validCounter(d.revisionNumber, 1) ||
    r.expectedRevision !== d.revisionNumber
  )
    return refused('FOREMAN_REVISION_CHANGED');
  if (
    !validCounter(r.expectedVersion, 0) ||
    !validCounter(c.reviewVersion, 0) ||
    r.expectedVersion !== c.reviewVersion
  )
    return refused('REVIEW_VERSION_CONFLICT');
  if (c.reviewVersion >= 1_000_000) return refused('REVIEW_VERSION_EXHAUSTED');
  if (r.decision !== 'CONFIRM_SCOPE' && !r.reason.trim())
    return refused('REASON_REQUIRED');
  const e = c.evidence;
  if (
    r.evidenceBasis !== null &&
    (!e ||
      e.orgId !== d.orgId ||
      !sameCompletionTarget(e.target, r.target) ||
      !sameEvidenceBasis(e.basis, r.evidenceBasis))
  )
    return refused('EVIDENCE_CHANGED');
  let confirmedQty: string | null = null;
  let scopeRef: string | null = null;
  let unit: string | null = null;
  if (r.decision === 'CONFIRM_SCOPE') {
    if (!r.method.trim()) return refused('METHOD_REQUIRED');
    if (
      !e ||
      !r.evidenceBasis ||
      (e.state !== 'READY' && e.state !== 'PARTIAL') ||
      !e.coverage ||
      !usablePhotos(e.photos)
    )
      return refused('EVIDENCE_REQUIRED');
    if (
      d.scopeStatus !== 'CONFIRMED' ||
      !d.scopeRef ||
      e.coverage.withinScopeRef !== d.scopeRef
    )
      return refused('SCOPE_UNCONFIRMED');
    if (!d.unit?.trim() || e.coverage.unit !== d.unit)
      return refused('UNIT_MISMATCH');
    const declared = dec(d.qty);
    const evidenced = dec(e.coverage.qty);
    if (declared === null) return refused('QUANTITY_UNKNOWN');
    if (evidenced === null || evidenced > declared)
      return refused('COVERAGE_INVALID');
    if (!r.coverage) return refused('COVERAGE_INVALID');
    const quantity =
      r.coverage.kind === 'WHOLE' ? declared : dec(r.coverage.qty);
    if (quantity === null || quantity > evidenced || quantity > declared)
      return refused('COVERAGE_INVALID');
    const scope =
      r.coverage.kind === 'WHOLE' ? d.scopeRef : r.coverage.scopeRef;
    if (
      scope !== e.coverage.scopeRef ||
      (r.coverage.kind === 'WHOLE' && e.state !== 'READY')
    )
      return refused('COVERAGE_INVALID');
    // Equal quantities alone do not prove complete physical coverage of the declaration.
    if (r.coverage.kind === 'PARTIAL' && quantity >= declared)
      return refused('COVERAGE_INVALID');
    confirmedQty = decText(quantity);
    scopeRef = scope;
    unit = d.unit;
  } else if (r.coverage !== null) return refused('COVERAGE_INVALID');
  return {
    ok: true,
    value: {
      target: { ...r.target },
      version: c.reviewVersion + 1,
      decision: r.decision,
      confirmedQty,
      scopeRef,
      unit,
      evidenceBasis: r.evidenceBasis ? { ...r.evidenceBasis } : null,
      reason: r.reason,
      method: r.method,
      limitations: r.limitations,
      reviewerPersonId: c.authority.personId!,
      reviewerAccountId: c.authority.accountId,
      authorityGrantId: grant.value,
    },
  };
}

export interface CompletionReviewEvent extends CompletionReviewPlan {
  readonly id: string;
  readonly orgId: string;
}

function sameEvent(
  a: CompletionReviewEvent,
  b: CompletionReviewEvent,
): boolean {
  return (
    a.id === b.id &&
    a.orgId === b.orgId &&
    sameCompletionTarget(a.target, b.target) &&
    a.version === b.version &&
    a.decision === b.decision &&
    a.confirmedQty === b.confirmedQty &&
    a.scopeRef === b.scopeRef &&
    a.unit === b.unit &&
    (a.evidenceBasis === null
      ? b.evidenceBasis === null
      : b.evidenceBasis !== null &&
        sameEvidenceBasis(a.evidenceBasis, b.evidenceBasis)) &&
    a.reason === b.reason &&
    a.method === b.method &&
    a.limitations === b.limitations &&
    a.reviewerPersonId === b.reviewerPersonId &&
    a.reviewerAccountId === b.reviewerAccountId &&
    a.authorityGrantId === b.authorityGrantId
  );
}
export interface CompletionReviewState {
  readonly target: CompletionTarget;
  readonly status:
    | 'NOT_CHECKED'
    | 'REVIEW_REQUIRED'
    | 'CONFIRMED_SCOPE'
    | 'INCONCLUSIVE'
    | 'RETURNED';
  readonly coverage: 'NONE' | 'PARTIAL' | 'FULL';
  readonly confirmedQty: string | null;
  readonly unit: string | null;
  readonly eventId: string | null;
  readonly reviewVersion: number;
}

/** No summing judgments. Old revision judgments remain history, never confirmations of r2. */
export function completionReviewState(
  authority: ReviewAuthority,
  d: CompletionDeclaration,
  evidence: CompletionEvidence | null,
  events: readonly CompletionReviewEvent[],
): ReviewRuleResult<CompletionReviewState> {
  const access = reviewAuthorityGrant(
    authority,
    d.orgId,
    d.target,
    'READ_REVIEW',
  );
  if (!access.ok) return access;
  const scoped = events.filter(
    (e) => e.orgId === d.orgId && sameScope(e.target, d.target),
  );
  const current = scoped.filter((e) =>
    sameCompletionTarget(e.target, d.target),
  );
  const state: CompletionReviewState = {
    target: { ...d.target },
    status: scoped.length ? 'REVIEW_REQUIRED' : 'NOT_CHECKED',
    coverage: 'NONE',
    confirmedQty: null,
    unit: null,
    eventId: null,
    reviewVersion: 0,
  };
  if (current.length === 0) return { ok: true, value: state };
  if (current.some((e) => !validCounter(e.version, 1)))
    return refused('REVIEW_HISTORY_CONFLICT');
  const byId = new Map<string, CompletionReviewEvent>();
  const byVersion = new Map<number, string>();
  for (const e of current) {
    const copy = byId.get(e.id);
    const existingId = byVersion.get(e.version);
    if (
      !e.id.trim() ||
      (copy && !sameEvent(copy, e)) ||
      (existingId !== undefined && existingId !== e.id)
    )
      return refused('REVIEW_HISTORY_CONFLICT');
    byId.set(e.id, e);
    byVersion.set(e.version, e.id);
  }
  const lastVersion = current.reduce((n, e) => Math.max(n, e.version), 0);
  const latest = current.filter((e) => e.version === lastVersion);
  // Replayed identical copies are harmless; conflicting stored contents are not guessed away.
  const event = latest[0]!;
  const base = { ...state, eventId: event.id, reviewVersion: event.version };
  if (event.decision !== 'CONFIRM_SCOPE')
    return {
      ok: true,
      value: {
        ...base,
        status: event.decision === 'RETURN' ? 'RETURNED' : 'INCONCLUSIVE',
      },
    };
  const quantity = dec(event.confirmedQty);
  const declared = dec(d.qty);
  const cap = evidence?.coverage;
  const evidenced = cap ? dec(cap.qty) : null;
  if (
    !evidence ||
    evidence.orgId !== d.orgId ||
    !sameCompletionTarget(evidence.target, d.target) ||
    !event.evidenceBasis ||
    !sameEvidenceBasis(event.evidenceBasis, evidence.basis) ||
    (evidence.state !== 'READY' && evidence.state !== 'PARTIAL') ||
    !usablePhotos(evidence.photos) ||
    !cap ||
    cap.withinScopeRef !== d.scopeRef ||
    d.scopeStatus !== 'CONFIRMED' ||
    event.scopeRef !== cap.scopeRef ||
    !d.scopeRef?.trim() ||
    !cap.scopeRef.trim() ||
    !d.unit?.trim() ||
    event.unit !== d.unit ||
    cap.unit !== d.unit ||
    quantity === null ||
    declared === null ||
    quantity > declared ||
    evidenced === null ||
    evidenced > declared ||
    quantity > evidenced
  )
    return { ok: true, value: base };
  const full =
    quantity === declared &&
    event.scopeRef === d.scopeRef &&
    evidence.state === 'READY';
  if (quantity === declared && !full) return { ok: true, value: base };
  return {
    ok: true,
    value: {
      ...base,
      status: 'CONFIRMED_SCOPE',
      coverage: full ? 'FULL' : 'PARTIAL',
      confirmedQty: decText(quantity),
      unit: d.unit,
    },
  };
}
