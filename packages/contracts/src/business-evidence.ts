/** Versioned associations to an existing declaration. Neither binding nor READY verifies it. */
import type {
  CompletionEvidenceBasisDto,
  CompletionEvidenceDto,
  CompletionReviewTargetDto,
} from './manager-review.js';
import {
  parseCompletionEvidenceBasis,
  parseCompletionReviewTarget,
} from './manager-review.js';
import { InvalidReportInput, id, str, version } from './parse.js';
import { reported } from './report.js';
import { reportObject } from './report-source.js';

export type EvidenceTarget = CompletionReviewTargetDto;
export type EvidenceBasis = CompletionEvidenceBasisDto;
export type FactEvidence = CompletionEvidenceDto;
export interface EvidencePhotoRef {
  photoId: string;
  photoVersion: number;
}
/** Null fields preserve missing scope/quantity/unit; they never mean zero or full coverage. */
export interface EvidenceCoverage {
  scopeRef: string | null;
  withinScopeRef: string | null;
  qty: string | null;
  unit: string | null;
}
interface EvidenceCommandBase {
  schemaVersion: 1;
  clientMutationId: string;
  target: EvidenceTarget;
  expectedRevision: number;
  /** Null explicitly means no association set existed, not permission to overwrite one. */
  expectedBasis: EvidenceBasis | null;
}
export type BusinessEvidenceCommand = EvidenceCommandBase &
  (
    | { operation: 'BIND'; photo: EvidencePhotoRef; coverage: EvidenceCoverage }
    | { operation: 'UNBIND'; linkId: string }
  );

export function parseEvidenceCoverage(v: unknown): EvidenceCoverage {
  const o = reportObject(
    v,
    ['scopeRef', 'withinScopeRef', 'qty', 'unit'],
    'coverage',
  );
  const qty = o['qty'] === null ? null : reported(o['qty'], 'coverage.qty');
  if (qty === '' || qty === 'unknown' || qty === 'na')
    throw new InvalidReportInput('coverage.qty');
  return {
    scopeRef:
      o['scopeRef'] === null ? null : id(o['scopeRef'], 'coverage.scopeRef'),
    withinScopeRef:
      o['withinScopeRef'] === null
        ? null
        : id(o['withinScopeRef'], 'coverage.withinScopeRef'),
    qty,
    unit: o['unit'] === null ? null : str(o['unit'], 'coverage.unit', 80),
  };
}

export function parseBusinessEvidenceCommand(
  v: unknown,
): BusinessEvidenceCommand {
  const keys = [
    'schemaVersion',
    'clientMutationId',
    'target',
    'expectedRevision',
    'expectedBasis',
    'operation',
  ];
  const first = reportObject(
    v,
    [...keys, 'photo', 'coverage', 'linkId'],
    'command',
  );
  const op = first['operation'];
  if (op !== 'BIND' && op !== 'UNBIND')
    throw new InvalidReportInput('operation');
  const o = reportObject(
    v,
    [...keys, ...(op === 'BIND' ? ['photo', 'coverage'] : ['linkId'])],
    'command',
  );
  if (o['schemaVersion'] !== 1) throw new InvalidReportInput('schemaVersion');
  const n = version(o['expectedRevision'], 'expectedRevision');
  if (n === 0) throw new InvalidReportInput('expectedRevision');
  const base: EvidenceCommandBase = {
    schemaVersion: 1,
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    target: parseCompletionReviewTarget(o['target']),
    expectedRevision: n,
    expectedBasis:
      o['expectedBasis'] === null
        ? null
        : parseCompletionEvidenceBasis(o['expectedBasis']),
  };
  if (op === 'UNBIND')
    return { ...base, operation: op, linkId: id(o['linkId'], 'linkId') };
  const photo = reportObject(o['photo'], ['photoId', 'photoVersion'], 'photo');
  const pv = version(photo['photoVersion'], 'photo.photoVersion');
  if (pv === 0) throw new InvalidReportInput('photo.photoVersion');
  return {
    ...base,
    operation: op,
    photo: { photoId: id(photo['photoId'], 'photo.photoId'), photoVersion: pv },
    coverage: parseEvidenceCoverage(o['coverage']),
  };
}

/** Authorized read cut supplied by the real provider, not fabricated by the view. */
export interface EvidenceWorkspace {
  target: EvidenceTarget;
  revisionNumber: number;
  declaration: { qty: string; unit: string | null; scopeRef: string | null };
  evidence: FactEvidence | null;
  /** Raw association declaration from the same cut; C04 coverage is only its complete projection. */
  associationCoverage: EvidenceCoverage | null;
  availablePhotos: readonly (EvidencePhotoRef & { label: string })[];
  scopes: readonly { id: string; withinScopeRef: string; label: string }[];
  history: readonly FactEvidence[];
  canBind: boolean;
}
