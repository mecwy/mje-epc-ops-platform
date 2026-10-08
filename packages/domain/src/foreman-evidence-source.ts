/** Foreman-owned immutable source exit; current catalog labels are not historical proof. */
import type { EvidenceTarget } from '@mje/contracts';
import type {
  EvidenceDeclarationSource,
  BusinessEvidencePorts,
} from './business-evidence-store.js';
import { BusinessEvidenceError } from './business-evidence-store.js';
import {
  readForemanEvidenceSource,
  ManagerReviewError,
} from './manager-review-reader.js';
import {
  DENY_REVIEW_PORTS,
  type ReviewServerPorts,
} from './manager-review-store.js';
export async function foremanEvidenceSource(
  client: Parameters<BusinessEvidencePorts['resolveDeclaration']>[0],
  actor: Parameters<BusinessEvidencePorts['resolveDeclaration']>[1],
  target: EvidenceTarget,
  sourceContextFor: ReviewServerPorts['sourceContextFor'] = DENY_REVIEW_PORTS.sourceContextFor,
): Promise<EvidenceDeclarationSource | null> {
  try {
    return await readForemanEvidenceSource(
      client,
      actor,
      target,
      sourceContextFor,
    );
  } catch (error) {
    if (
      error instanceof ManagerReviewError &&
      error.code === 'SOURCE_UNAVAILABLE'
    )
      throw new BusinessEvidenceError('SOURCE_UNAVAILABLE');
    throw error;
  }
}
