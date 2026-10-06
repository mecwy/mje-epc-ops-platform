/** Explicit completion-evidence service boundary. No client tenant, grant or source quantity. */
import type {
  BusinessEvidenceCommand,
  EvidenceBasis,
  EvidenceTarget,
  EvidenceWorkspace,
  EvidenceCoverage,
  FactEvidence,
} from './business-evidence.js';
import { parseEvidenceCoverage } from './business-evidence.js';
import {
  parseCompletionReviewTarget,
  parseCompletionEvidenceBasis,
} from './manager-review.js';
import { InvalidReportInput, id, version } from './parse.js';
import { reportObject } from './report-source.js';

export interface BusinessEvidenceIdentity {
  tenantId: string;
  objectId: string;
}
export interface BusinessEvidenceReceipt {
  target: EvidenceTarget;
  basis: EvidenceBasis;
  manifestId: string;
  daySeq: number;
  changed: boolean;
}
export interface BusinessEvidenceService {
  read(
    identity: BusinessEvidenceIdentity,
    target: EvidenceTarget,
  ): Promise<EvidenceWorkspace>;
  write(
    identity: BusinessEvidenceIdentity,
    command: BusinessEvidenceCommand,
  ): Promise<BusinessEvidenceReceipt>;
}
/** GET parameters are exactly the immutable fact tuple, including its original source revision. */
export function parseBusinessEvidenceQuery(value: unknown): EvidenceTarget {
  return parseCompletionReviewTarget(value);
}
export function parseBusinessEvidenceReceipt(
  value: unknown,
): BusinessEvidenceReceipt {
  const o = reportObject(
    value,
    ['target', 'basis', 'manifestId', 'daySeq', 'changed'],
    'receipt',
  );
  if (typeof o['changed'] !== 'boolean')
    throw new InvalidReportInput('receipt.changed');
  const seq = o['daySeq'];
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1)
    throw new InvalidReportInput('receipt.daySeq');
  return {
    target: parseCompletionReviewTarget(o['target']),
    basis: parseCompletionEvidenceBasis(o['basis']),
    manifestId: id(o['manifestId'], 'receipt.manifestId'),
    daySeq: seq,
    changed: o['changed'],
  };
}
/** Stored manifest decoder: raw coverage remains distinct from its complete C04 projection. */
export function parseBusinessEvidenceManifest(value: unknown): {
  evidence: FactEvidence;
  associationCoverage: EvidenceCoverage | null;
} {
  const o = reportObject(
    value,
    ['target', 'basis', 'state', 'coverage', 'photos'],
    'manifest',
  );
  const state = o['state'];
  if (
    state !== 'MISSING' &&
    state !== 'PARTIAL' &&
    state !== 'READY' &&
    state !== 'UNCONFIRMED_SCOPE'
  )
    throw new InvalidReportInput('manifest.state');
  const coverage =
    o['coverage'] === null ? null : parseEvidenceCoverage(o['coverage']);
  const list = o['photos'];
  if (!Array.isArray(list) || list.length > 1000)
    throw new InvalidReportInput('manifest.photos');
  const photos = list.map((p: unknown) => {
    const photo = reportObject(
      p,
      ['photoId', 'photoVersion', 'linkId'],
      'manifest.photo',
    );
    const photoVersion = version(
      photo['photoVersion'],
      'manifest.photoVersion',
    );
    if (photoVersion < 1) throw new InvalidReportInput('manifest.photoVersion');
    return {
      photoId: id(photo['photoId'], 'manifest.photoId'),
      photoVersion,
      linkId: id(photo['linkId'], 'manifest.linkId'),
    };
  });
  if (
    new Set(photos.map((p) => p.linkId)).size !== photos.length ||
    new Set(photos.map((p) => `${p.photoId}:${p.photoVersion}`)).size !==
      photos.length
  )
    throw new InvalidReportInput('manifest.photos');
  return {
    associationCoverage: coverage,
    evidence: {
      target: parseCompletionReviewTarget(o['target']),
      basis: parseCompletionEvidenceBasis(o['basis']),
      state,
      photos,
      coverage:
        coverage?.scopeRef &&
        coverage.withinScopeRef &&
        coverage.qty !== null &&
        coverage.unit?.trim()
          ? {
              scopeRef: coverage.scopeRef,
              withinScopeRef: coverage.withinScopeRef,
              qty: coverage.qty,
              unit: coverage.unit,
            }
          : null,
    },
  };
}
