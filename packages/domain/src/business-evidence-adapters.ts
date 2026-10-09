/** Compose explicit source/media/policy exits; SQL remains with its existing owner. */
import type { BusinessEvidenceReadPorts } from './business-evidence-reader.js';
import { businessEvidenceCurrentCut } from './business-evidence-reader.js';
import { foremanEvidenceSource } from './foreman-evidence-source.js';
import {
  businessEvidenceDayGate,
  createBusinessEvidenceService,
  deniedBusinessEvidencePorts,
} from './business-evidence-store.js';
import {
  DENY_REVIEW_PORTS,
  type ReviewServerPorts,
} from './manager-review-store.js';
export function businessEvidencePorts(
  exits: Partial<BusinessEvidenceReadPorts> = {},
  sourceContextFor: ReviewServerPorts['sourceContextFor'] = DENY_REVIEW_PORTS.sourceContextFor,
): BusinessEvidenceReadPorts {
  return {
    ...deniedBusinessEvidencePorts,
    resolveDeclaration: (client, actor, target) =>
      foremanEvidenceSource(client, actor, target, sourceContextFor),
    listMedia: () => Promise.resolve([]),
    resolveReadCut: businessEvidenceCurrentCut,
    withDayGate: businessEvidenceDayGate,
    ...exits,
  };
}
export const businessEvidenceService = createBusinessEvidenceService;
