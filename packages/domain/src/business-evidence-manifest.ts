/** Immutable evidence identities frozen by the report owner at its existing FieldDay cut. */
import type { EvidenceTarget, EvidenceBasis } from '@mje/contracts';
import {
  parseBusinessEvidenceQuery,
  parseBusinessEvidenceReceipt,
} from '@mje/contracts';
import { sameCompletionTarget } from './manager-review-rules.js';
import { BusinessEvidenceError } from './business-evidence-store.js';

export interface BusinessEvidenceSnapshotCut {
  asOfSeq: number;
  manifests: {
    target: EvidenceTarget;
    id: string;
    basis: EvidenceBasis;
    daySeq: number;
  }[];
}
function assertSequence(seq: number) {
  if (!Number.isSafeInteger(seq) || seq < 0)
    throw new BusinessEvidenceError('INTEGRATION_REQUIRED');
}
export { businessEvidenceSnapshotCut } from './business-evidence-reader.js';

/** Missing legacy cut means no frozen evidence. A malformed present cut must fail visibly. */
export function frozenEvidenceManifest(
  raw: unknown,
  target: EvidenceTarget,
  daySeq: number,
): { id: string; basis: EvidenceBasis } | null {
  assertSequence(daySeq);
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new BusinessEvidenceError('INTEGRATION_REQUIRED');
  const cut = raw as Record<string, unknown>;
  if (
    cut['asOfSeq'] !== daySeq ||
    !Array.isArray(cut['manifests']) ||
    cut['manifests'].length > 1000
  )
    throw new BusinessEvidenceError('INTEGRATION_REQUIRED');
  let selected: { id: string; basis: EvidenceBasis } | null = null;
  const seen = new Set<string>();
  for (const rawEntry of cut['manifests']) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry))
      throw new BusinessEvidenceError('INTEGRATION_REQUIRED');
    const entry = rawEntry as Record<string, unknown>;
    const parsedTarget = parseBusinessEvidenceQuery(entry['target']);
    const receipt = parseBusinessEvidenceReceipt({
      target: parsedTarget,
      basis: entry['basis'],
      manifestId: entry['id'],
      daySeq: entry['daySeq'],
      changed: false,
    });
    const key = JSON.stringify(parsedTarget);
    if (
      seen.has(key) ||
      receipt.daySeq > daySeq ||
      parsedTarget.projectId !== target.projectId ||
      parsedTarget.businessDate !== target.businessDate
    )
      throw new BusinessEvidenceError('INTEGRATION_REQUIRED');
    seen.add(key);
    if (sameCompletionTarget(parsedTarget, target))
      selected = { id: receipt.manifestId, basis: receipt.basis };
  }
  return selected;
}
