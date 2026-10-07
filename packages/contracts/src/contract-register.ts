/** Contract register header slice. Project shares and mutation DTOs land separately. */
export type ContractDirection = 'INCOME' | 'EXPENDITURE';
export type ContractValueState =
  'VALUE' | 'BLANK' | 'UNKNOWN' | 'NA' | 'NOT_STATED';
export interface ContractAmountDto {
  visibility: 'visible' | 'restricted';
  restriction?: 'PROJECT_SCOPE' | 'CAPABILITY';
  state?: ContractValueState;
  value?: string | null;
  currency?: string | null;
  taxBasis?: 'INCLUSIVE' | 'EXCLUSIVE' | 'UNKNOWN';
}
export interface ContractSourceDto {
  sourceDocumentId: string;
  location: string;
  filename: string;
  sha256: string;
}
export interface ContractRevisionDto {
  n: number;
  name: string;
  originalNumber: string | null;
  counterpartyRaw: string | null;
  selfPartyRaw: string | null;
  informationOwnerPersonId: string | null;
  informationOwnerDisplayName: string | null;
  registeredAt: string;
  signedOn: { state: 'VALUE' | 'UNKNOWN' | 'NOT_STATED'; value: string | null };
  effectiveOn: {
    state: 'VALUE' | 'UNKNOWN' | 'NOT_STATED';
    value: string | null;
  };
  registrationStatus: 'SIGNED_PENDING' | 'EFFECTIVE';
  lines: ContractLineDto[];
  total: ContractAmountDto;
  internal: {
    visibility: 'visible' | 'restricted';
    correctionReason?: string | null;
  };
  evidence: {
    visibility: 'visible' | 'restricted';
    sources?: ContractSourceDto[];
    headLocs?: {
      parties: ContractSourceDto | null;
      dates: ContractSourceDto | null;
      total: ContractSourceDto | null;
    };
  };
}
export interface ContractLineDto {
  id: string;
  lineNo: string;
  description: string;
  quantity: { state: ContractValueState; value: string | null };
  unitRaw: string;
  unit: string | null;
  removed: boolean;
  amount: ContractAmountDto;
  pricing: { visibility: 'visible' | 'restricted'; type?: string };
  internal: {
    visibility: 'visible' | 'restricted';
    includes?: string;
    excludes?: string;
    derivation?: string;
  };
  evidence: {
    visibility: 'visible' | 'restricted';
    source?: ContractSourceDto | null;
    removalSource?: ContractSourceDto | null;
  };
  shares: ContractShareDto[];
  allocation: {
    state:
      | 'UNALLOCATED'
      | 'PARTIAL'
      | 'ALLOCATED'
      | 'UNQUANTIFIED'
      | 'RECONCILE'
      | 'RESTRICTED';
    remaining: string | null;
  };
  sharedLineAmount: boolean;
  canMaintainShares: boolean;
}
export interface ContractShareDto {
  scopeId: string;
  projectId: string;
  version: number;
  pinnedRevisionN: number;
  basis: 'WHOLE' | 'QUANTITY' | 'AREA' | 'NOTE';
  quantity: string | null;
  unitRaw: string;
  unit: string | null;
  description: string;
  retired: boolean;
  needsReconciliation: boolean;
  internal: {
    visibility: 'visible' | 'restricted';
    area?: string;
    note?: string;
    reason?: string;
  };
}
export interface ContractRegisterItemDto {
  id: string;
  code: string;
  direction: ContractDirection;
  expenditureSubtype: 'SUBCONTRACT' | 'PURCHASE' | null;
  latest: ContractRevisionDto;
  attention: {
    visibility: 'visible' | 'restricted';
    entries?: {
      id: string;
      revisionN: number;
      kind: 'UNASSIGNED' | 'CORRECTION' | 'SHARE_MISASSIGNED';
      read: boolean;
      requiresAnotherPerson: boolean;
    }[];
  };
}
export interface ContractHistoryDto {
  id: string;
  revisions: ContractRevisionDto[];
  shareVersions: ContractShareDto[];
}
