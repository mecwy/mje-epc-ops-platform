import type { ContractDirection } from '@mje/contracts';
export type ContractCapability =
  | 'contract.view'
  | 'contract.amount'
  | 'contract.terms'
  | 'contract.original'
  | 'contract.internal'
  | 'contract.maintain'
  | 'contract.attention';
export interface ContractGrant {
  capability: ContractCapability;
  direction: ContractDirection | 'ALL';
  scope: 'ORG' | 'PROJECT';
  projectId: string | null;
}
/** Header reads require organization grants; a project grant never implies header amounts. */
export function allowsHeader(
  grants: readonly ContractGrant[],
  capability: ContractCapability,
  direction: ContractDirection,
): boolean {
  return grants.some(
    (g) =>
      g.capability === capability &&
      g.scope === 'ORG' &&
      (g.direction === 'ALL' || g.direction === direction),
  );
}
export class ContractRegisterError extends Error {
  constructor(public readonly code: 'NOT_FOUND' | 'FORBIDDEN') {
    super(code);
  }
}
