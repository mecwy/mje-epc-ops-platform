/** Contract register header slice. Project shares and mutation DTOs land separately. */
export type ContractDirection = 'INCOME' | 'EXPENDITURE';
export type ContractValueState =
  'VALUE' | 'BLANK' | 'UNKNOWN' | 'NA' | 'NOT_STATED';
export interface ContractAmountDto {
  visibility: 'visible' | 'restricted';
  state?: ContractValueState;
  value?: string | null;
  currency?: string | null;
}
export interface ContractRevisionDto {
  n: number;
  name: string;
  originalNumber: string | null;
  counterpartyRaw: string | null;
  selfPartyRaw: string | null;
  informationOwnerPersonId: string | null;
  registeredAt: string;
  total: ContractAmountDto;
  internal: {
    visibility: 'visible' | 'restricted';
    correctionReason?: string | null;
  };
  evidence: {
    visibility: 'visible' | 'restricted';
    sources?: { sourceDocumentId: string; location: string }[];
  };
}
export interface ContractRegisterItemDto {
  id: string;
  code: string;
  direction: ContractDirection;
  expenditureSubtype: 'SUBCONTRACT' | 'PURCHASE' | null;
  latest: ContractRevisionDto;
}
export interface ContractHistoryDto {
  id: string;
  revisions: ContractRevisionDto[];
}
