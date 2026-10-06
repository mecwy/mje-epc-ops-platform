/** Commercial declarations; none of these records authorize work, billing or payment. */
export const OPPORTUNITY_STATES = [
  'VALUE',
  'BLANK',
  'UNKNOWN',
  'NA',
  'NOT_STATED',
] as const;
export type OpportunityState = (typeof OPPORTUNITY_STATES)[number];
export interface OpportunityValue {
  state: OpportunityState;
  value: string | null;
}
export interface OpportunityScale {
  value: OpportunityValue;
  unitRaw: string | null;
  basis: OpportunityValue;
}
export interface OpportunityOccurrence {
  occurredAt: string | null;
  timezone: string | null;
  businessDate: string | null;
}
export const OPPORTUNITY_PARTY_ROLES = [
  'OWNER',
  'INVESTOR',
  'EPC_CONTRACTOR',
  'CUSTOMER',
  'PAYER',
  'REFERRER',
  'COMPETITOR',
  'OTHER',
] as const;
export interface OpportunityParty {
  id: string;
  role: (typeof OPPORTUNITY_PARTY_ROLES)[number];
  rawName: OpportunityValue;
  companyId: string | null;
}
export interface OpportunityCondition {
  id: string;
  summary: string;
  responsibleRaw: OpportunityValue;
  status: 'UNMET' | 'MET' | 'NA' | 'UNKNOWN' | 'NOT_STATED';
  basis: string | null;
}
export interface OpportunityOwnerProject {
  projectType: OpportunityValue;
  country: OpportunityValue;
  city: OpportunityValue;
  reportedScale: OpportunityScale;
  conditions: OpportunityCondition[];
}
export interface OpportunityProposedScope {
  id: string;
  roleRaw: OpportunityValue;
  summary: OpportunityValue;
  scale: OpportunityScale;
}
export interface OpportunityDates {
  tender: OpportunityValue;
  expectedSigning: OpportunityValue;
  expectedStart: OpportunityValue;
  expectedCompletion: OpportunityValue;
}
export interface OpportunityFacts {
  name: string;
  businessLine: OpportunityValue;
  customerGroup: OpportunityValue;
  informationOwnerPersonId: string | null;
  assistantPersonIds: string[];
  parties: OpportunityParty[];
  ownerProject: OpportunityOwnerProject;
  proposedScopes: OpportunityProposedScope[];
  dates: OpportunityDates;
  stageRaw: OpportunityValue;
  probabilityRaw: OpportunityValue;
  mustWinRaw: OpportunityValue;
  internalNote: OpportunityValue;
}
export interface OpportunitySource {
  sourceDocumentId: string | null;
  reference: string;
  location: string;
}
export type OpportunityFieldChange = {
  [K in keyof OpportunityFacts]: {
    field: K;
    before: OpportunityFacts[K];
    after: OpportunityFacts[K];
    reason: string;
    basis: string | null;
  };
}[keyof OpportunityFacts];
export interface OpportunityNextStepInput {
  id: string;
  action: string;
  ownerPersonId: string | null;
  dueOn: OpportunityValue;
}
export type OpportunityNextStepChange =
  | { mode: 'KEEP' }
  | {
      mode: 'REPLACE' | 'COMPLETE_AND_ADD';
      baseStepId: string | null;
      next: OpportunityNextStepInput;
    };
interface OpportunityCommand {
  opportunityId: string;
  clientMutationId: string;
}
export interface CreateOpportunityCommand extends OpportunityCommand {
  expectedVersion: 0;
  code: string | null;
  facts: OpportunityFacts;
  sources: OpportunitySource[];
}
export interface UpdateOpportunityCommand extends OpportunityCommand {
  /** Null only for an append-only fact/contact update which changes no existing field. */
  expectedVersion: number | null;
  newFact: string | null;
  noMaterialChange: boolean;
  evidence: string | null;
  obstacle: string | null;
  occurrence: OpportunityOccurrence;
  sources: OpportunitySource[];
  changes: OpportunityFieldChange[];
  nextStep: OpportunityNextStepChange;
}
export interface RequestOpportunityDecisionCommand extends OpportunityCommand {
  expectedRequestId: string | null;
  requestId: string;
  requestedPersonId: string | null;
  explanation: string;
  dueOn: OpportunityValue;
  sources: OpportunitySource[];
}
export interface OpportunityDecisionState {
  kind: 'CONTINUE' | 'PAUSE' | 'EXIT';
  resumeCondition: string | null;
  reviewOn: OpportunityValue;
  exitReason: string | null;
  reentryCondition: string | null;
}
export interface OpportunityProxy {
  basis: string;
  from: OpportunityValue;
  until: OpportunityValue;
}
export interface RecordOpportunityDecisionCommand extends OpportunityCommand {
  expectedDecisionVersion: number;
  expectedRequestId: string | null;
  actualDecisionPersonId: string;
  decision: OpportunityDecisionState;
  recordText: string;
  basis: string;
  occurrence: OpportunityOccurrence;
  proxy: OpportunityProxy | null;
  sources: OpportunitySource[];
}
export interface OpportunityCommandResult {
  opportunityId: string;
  version: number;
}
export type OpportunityProjected<T> =
  { visibility: 'visible'; value: T } | { visibility: 'restricted' };
export interface OpportunityConditionDto extends Omit<
  OpportunityCondition,
  'basis'
> {
  basis: OpportunityProjected<string | null>;
}
export interface OpportunityFactsDto extends Omit<
  OpportunityFacts,
  'ownerProject' | 'probabilityRaw' | 'mustWinRaw' | 'internalNote'
> {
  ownerProject: Omit<OpportunityOwnerProject, 'conditions'> & {
    conditions: OpportunityConditionDto[];
  };
  probabilityRaw: OpportunityProjected<OpportunityValue>;
  mustWinRaw: OpportunityProjected<OpportunityValue>;
  internalNote: OpportunityProjected<OpportunityValue>;
}
export interface OpportunitySourceDto extends OpportunitySource {
  filename: string | null;
  sha256: string | null;
}
export interface OpportunityNextStepDto extends OpportunityNextStepInput {
  createdAt: string;
  completed: boolean;
}
export interface OpportunityRequestDto {
  id: string;
  requestedPersonId: string | null;
  explanation: OpportunityProjected<string>;
  dueOn: OpportunityValue;
  raisedByPersonId: string;
  recordedByAccountId: string;
  recordedAt: string;
}
export interface OpportunityDecisionDto {
  n: number;
  current: OpportunityDecisionState;
  previous: OpportunityDecisionState;
  actualDecisionPersonId: string;
  recordedByAccountId: string;
  recordedByPersonId: string;
  recordedAt: string;
  occurrence: OpportunityOccurrence;
  recordText: OpportunityProjected<string>;
  basis: OpportunityProjected<string>;
  proxy: OpportunityProjected<OpportunityProxy | null>;
  resolvedRequest: OpportunityRequestDto | null;
}
export type OpportunityFieldValueDto =
  | string
  | null
  | string[]
  | OpportunityValue
  | OpportunityParty[]
  | OpportunityFactsDto['ownerProject']
  | OpportunityProposedScope[]
  | OpportunityDates;
export interface OpportunityFieldChangeDto {
  field: keyof OpportunityFacts;
  before: OpportunityProjected<OpportunityFieldValueDto>;
  after: OpportunityProjected<OpportunityFieldValueDto>;
  reason: OpportunityProjected<string>;
  basis: OpportunityProjected<string | null>;
  dateChange: 'RESCHEDULE' | 'CERTAINTY' | null;
}
export interface OpportunityUpdateDto {
  id: string;
  n: number;
  newFact: string | null;
  noMaterialChange: boolean;
  evidence: OpportunityProjected<string | null>;
  obstacle: OpportunityProjected<string | null>;
  recordedAt: string;
  recordedByAccountId: string;
  recordedByPersonId: string;
  occurrence: OpportunityOccurrence;
  sources: OpportunityProjected<OpportunitySourceDto[]>;
  changes: OpportunityFieldChangeDto[];
  nextStepMode: OpportunityNextStepChange['mode'];
  nextStep: OpportunityNextStepDto | null;
  completedStepId: string | null;
}
export interface OpportunityRevisionDto {
  n: number;
  facts: OpportunityFactsDto;
  sources: OpportunityProjected<OpportunitySourceDto[]>;
  recordedAt: string;
  recordedByAccountId: string;
  recordedByPersonId: string;
}
export interface OpportunityItemDto {
  id: string;
  code: string;
  version: number;
  revision: OpportunityRevisionDto;
  effectiveDecision: OpportunityDecisionState;
  decisionVersion: number;
  decisionIsDefault: boolean;
  pendingRequest: OpportunityRequestDto | null;
  nextStep: OpportunityNextStepDto | null;
  lastContact: OpportunityUpdateDto | null;
  lastSubstantiveProgress: OpportunityUpdateDto | null;
  rescheduleCount: number;
  capabilities: {
    maintain: boolean;
    amount: boolean;
    restrictedText: boolean;
    decide: boolean;
  };
}
export interface OpportunityHistoryDto {
  revisions: OpportunityRevisionDto[];
  updates: OpportunityUpdateDto[];
  decisions: OpportunityDecisionDto[];
  requests: OpportunityRequestDto[];
}
export interface OpportunityLookupsDto {
  accountId: string;
  personId: string;
  canCreateLead: boolean;
  people: { id: string; displayName: string }[];
  companies: { id: string; name: string }[];
  sources: { id: string; filename: string; sha256: string }[];
}
export interface OpportunityWorklistsDto {
  accountId: string;
  items: OpportunityItemDto[];
  myNextSteps: { opportunityId: string; step: OpportunityNextStepDto }[];
  weekChanges: { opportunityId: string; update: OpportunityUpdateDto }[];
  pendingDecisions: { opportunityId: string; request: OpportunityRequestDto }[];
  recordedWeek: { start: string; end: string };
}
