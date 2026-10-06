/** Transaction adapter supplies authority, original facts and actual authorized media. No SQL. */
import type {
  CompletionDeclaration,
  CompletionEvidence,
  EvidenceBasis,
  CompletionTarget,
} from './manager-review-rules.js';
import {
  sameCompletionTarget,
  sameEvidenceBasis,
} from './manager-review-rules.js';
import { dec as decimal } from './report-rules.js';

export interface BindingCoverage {
  scopeRef: string | null;
  withinScopeRef: string | null;
  qty: string | null;
  unit: string | null;
}
export type BindingRequest = {
  target: CompletionTarget;
  expectedRevision: number;
  expectedBasis: EvidenceBasis | null;
} & (
  | {
      operation: 'BIND';
      photo: { photoId: string; photoVersion: number };
      coverage: BindingCoverage;
    }
  | { operation: 'UNBIND'; linkId: string }
);
export interface BindingAuthority {
  orgId: string;
  projectId: string;
  crewId: string;
  itemKey: string;
  policyRef: string;
  allowed: readonly ('BIND' | 'UNBIND')[];
}
export interface BindingPhoto {
  orgId: string;
  projectId: string;
  businessDate: string;
  photoId: string;
  photoVersion: number;
  available: boolean;
  /** Resolved for this actor, purpose and fact. Ordinary report read permission is insufficient. */
  authorized: boolean;
}
export interface BindingContext {
  declaration: CompletionDeclaration;
  authority: BindingAuthority | null;
  current: CompletionEvidence | null;
  /** Original manifest fields, including nulls that cannot appear in the C04 projection. */
  currentCoverage: BindingCoverage | null;
  /** Re-resolved current references, not the previous availability state. */
  currentPhotos: readonly BindingPhoto[];
  photo: BindingPhoto | null;
  /** Explicit server-resolved containment pairs; no name/quantity inference. */
  scopes: readonly { scopeRef: string; withinScopeRef: string }[];
  /** Adapter allocates these once within the idempotent transaction. */
  newLinkSetId: string;
  newLinkId: string;
}
export type BindingCode =
  | 'FORBIDDEN'
  | 'TARGET_CHANGED'
  | 'REVISION_CONFLICT'
  | 'EVIDENCE_CHANGED'
  | 'PHOTO_NOT_AVAILABLE'
  | 'SCOPE_UNCONFIRMED'
  | 'UNIT_MISMATCH'
  | 'QUANTITY_UNKNOWN'
  | 'COVERAGE_INVALID'
  | 'COVERAGE_CONFLICT'
  | 'LINK_NOT_FOUND'
  | 'INVALID_IDENTITY';
export type BindingResult =
  | { ok: false; code: BindingCode }
  | {
      ok: true;
      changed: boolean;
      /** Previous association set remains immutable; the adapter appends this new manifest. */
      previousBasis: EvidenceBasis | null;
      associationCoverage: BindingCoverage | null;
      evidence: CompletionEvidence;
    };
const refuse = (code: BindingCode): BindingResult => ({ ok: false, code });
function sameCoverage(a: BindingCoverage | null, b: BindingCoverage): boolean {
  return (
    a !== null &&
    a.scopeRef === b.scopeRef &&
    a.withinScopeRef === b.withinScopeRef &&
    a.unit === b.unit &&
    decimal(a.qty) === decimal(b.qty) &&
    (a.qty === null) === (b.qty === null)
  );
}
export function planEvidenceBinding(
  r: BindingRequest,
  c: BindingContext,
): BindingResult {
  const d = c.declaration;
  const a = c.authority;
  if (
    !a ||
    a.orgId !== d.orgId ||
    a.projectId !== r.target.projectId ||
    a.crewId !== r.target.crewId ||
    a.itemKey !== r.target.itemKey ||
    !a.policyRef.trim() ||
    !a.allowed.includes(r.operation)
  )
    return refuse('FORBIDDEN');
  if (!sameCompletionTarget(r.target, d.target))
    return refuse('TARGET_CHANGED');
  if (
    !Number.isInteger(r.expectedRevision) ||
    r.expectedRevision < 1 ||
    r.expectedRevision > 1_000_000 ||
    r.expectedRevision !== d.revisionNumber
  )
    return refuse('REVISION_CONFLICT');
  const old = c.current;
  if (
    old &&
    (old.orgId !== d.orgId || !sameCompletionTarget(old.target, d.target))
  )
    return refuse('TARGET_CHANGED');
  if (
    old
      ? !r.expectedBasis || !sameEvidenceBasis(old.basis, r.expectedBasis)
      : r.expectedBasis !== null
  )
    return refuse('EVIDENCE_CHANGED');
  if (
    (old &&
      (!old.basis.linkSetId.trim() ||
        !Number.isInteger(old.basis.version) ||
        old.basis.version < 1 ||
        old.basis.version > 1_000_000)) ||
    !c.newLinkSetId.trim() ||
    !c.newLinkId.trim()
  )
    return refuse('INVALID_IDENTITY');
  let photos = old?.photos.map((p) => ({ ...p })) ?? [];
  let changed = true;
  let associationCoverage = c.currentCoverage ? { ...c.currentCoverage } : null;
  let coverage = old?.coverage ? { ...old.coverage } : null;
  if (r.operation === 'UNBIND') {
    if (!photos.some((p) => p.linkId === r.linkId))
      return refuse('LINK_NOT_FOUND');
    photos = photos.filter((p) => p.linkId !== r.linkId);
  } else {
    const p = c.photo;
    if (
      !p ||
      !p.authorized ||
      !p.available ||
      p.orgId !== d.orgId ||
      p.projectId !== d.target.projectId ||
      p.businessDate !== d.target.businessDate ||
      p.photoId !== r.photo.photoId ||
      p.photoVersion !== r.photo.photoVersion ||
      !Number.isSafeInteger(p.photoVersion) ||
      p.photoVersion < 1 ||
      p.photoVersion > 1_000_000
    )
      return refuse('PHOTO_NOT_AVAILABLE');
    const s = r.coverage;
    if (s.scopeRef !== null || s.withinScopeRef !== null) {
      if (
        !s.scopeRef ||
        !d.scopeRef ||
        s.withinScopeRef !== d.scopeRef ||
        !c.scopes.some(
          (x) => x.scopeRef === s.scopeRef && x.withinScopeRef === d.scopeRef,
        )
      )
        return refuse('SCOPE_UNCONFIRMED');
    }
    if (s.qty !== null) {
      const declared = decimal(d.qty),
        covered = decimal(s.qty);
      if (declared === null) return refuse('QUANTITY_UNKNOWN');
      if (covered === null || covered > declared)
        return refuse('COVERAGE_INVALID');
      if (!d.unit?.trim() || s.unit !== d.unit) return refuse('UNIT_MISMATCH');
    }
    const usableCoverage =
      s.scopeRef && s.withinScopeRef && s.qty !== null && s.unit?.trim()
        ? {
            scopeRef: s.scopeRef,
            withinScopeRef: s.withinScopeRef,
            qty: s.qty,
            unit: s.unit,
          }
        : null;
    if (photos.length && !sameCoverage(associationCoverage, s))
      return refuse('COVERAGE_CONFLICT');
    if (
      photos.some(
        (x) => x.photoId === p.photoId && x.photoVersion === p.photoVersion,
      )
    ) {
      changed = false;
    } else {
      if (photos.some((x) => x.linkId === c.newLinkId))
        return refuse('INVALID_IDENTITY');
      photos.push({
        photoId: p.photoId,
        photoVersion: p.photoVersion,
        linkId: c.newLinkId,
      });
    }
    if (changed) {
      coverage = usableCoverage;
      associationCoverage = { ...s };
    }
  }
  const basis = old
    ? { ...old.basis, version: old.basis.version + (changed ? 1 : 0) }
    : { linkSetId: c.newLinkSetId, version: 1 };
  if (!Number.isInteger(basis.version) || basis.version > 1_000_000)
    return refuse('INVALID_IDENTITY');
  const available = photos.every((ref) => {
    const p =
      r.operation === 'BIND' &&
      ref.photoId === c.photo?.photoId &&
      ref.photoVersion === c.photo.photoVersion
        ? c.photo
        : c.currentPhotos.find(
            (x) =>
              x.photoId === ref.photoId && x.photoVersion === ref.photoVersion,
          );
    return (
      p?.authorized === true &&
      p.available &&
      p.orgId === d.orgId &&
      p.projectId === d.target.projectId &&
      p.businessDate === d.target.businessDate
    );
  });
  const ready =
    coverage &&
    d.scopeStatus === 'CONFIRMED' &&
    coverage.scopeRef === d.scopeRef &&
    coverage.withinScopeRef === d.scopeRef &&
    coverage.unit === d.unit &&
    decimal(coverage.qty) !== null &&
    decimal(coverage.qty) === decimal(d.qty);
  const state =
    !photos.length || !available
      ? 'MISSING'
      : d.scopeStatus !== 'CONFIRMED' || !d.scopeRef
        ? 'UNCONFIRMED_SCOPE'
        : ready
          ? 'READY'
          : 'PARTIAL';
  return {
    ok: true,
    changed,
    previousBasis: old ? { ...old.basis } : null,
    associationCoverage,
    evidence: {
      orgId: d.orgId,
      target: { ...d.target },
      basis,
      state,
      coverage,
      photos,
    },
  };
}

/** Current confirmation must pin this exact set. History is never rewritten by this check. */
export function evidenceNeedsReview(
  current: CompletionEvidence | null,
  reviewed: { target: CompletionTarget; basis: EvidenceBasis } | null,
): boolean {
  return (
    reviewed !== null &&
    (!current ||
      current.state === 'MISSING' ||
      current.state === 'UNCONFIRMED_SCOPE' ||
      !sameCompletionTarget(current.target, reviewed.target) ||
      !sameEvidenceBasis(current.basis, reviewed.basis))
  );
}
