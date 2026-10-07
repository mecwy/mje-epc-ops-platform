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
export function allowsProject(
  grants: readonly ContractGrant[],
  capability: ContractCapability,
  direction: ContractDirection,
  projectId: string,
): boolean {
  return (
    allowsHeader(grants, capability, direction) ||
    grants.some(
      (g) =>
        g.capability === capability &&
        g.scope === 'PROJECT' &&
        g.projectId === projectId &&
        (g.direction === 'ALL' || g.direction === direction),
    )
  );
}
export const MAINTENANCE_CAPABILITIES = [
  'contract.view',
  'contract.amount',
  'contract.terms',
  'contract.original',
  'contract.internal',
  'contract.maintain',
] as const;
export function maintainsOrganization(
  grants: readonly ContractGrant[],
  direction: ContractDirection,
): boolean {
  return MAINTENANCE_CAPABILITIES.every((c) =>
    allowsHeader(grants, c, direction),
  );
}
export function maintainsProjects(
  grants: readonly ContractGrant[],
  direction: ContractDirection,
  projects: readonly string[],
): boolean {
  return (
    projects.length > 0 &&
    projects.every((p) =>
      MAINTENANCE_CAPABILITIES.every((c) =>
        allowsProject(grants, c, direction, p),
      ),
    )
  );
}
export class ContractRegisterError extends Error {
  constructor(
    public readonly code:
      | 'NOT_FOUND'
      | 'FORBIDDEN'
      | 'VERSION_CONFLICT'
      | 'INVALID_VALUE'
      | 'SOURCE_INVALID'
      | 'LINE_MISSING'
      | 'SHARE_INVALID'
      | 'RECONCILE_REQUIRED'
      | 'IDENTITY_EXISTS',
  ) {
    super(code);
  }
}
