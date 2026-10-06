import {
  blankOpportunityFacts,
  parseCreateOpportunity,
  parseUpdateOpportunity,
  parseRequestOpportunityDecision,
  parseRecordOpportunityDecision,
  type OpportunityFacts,
  type OpportunityItemDto,
  type OpportunityFieldChange,
  type OpportunityValue,
  type CreateOpportunityCommand,
  type UpdateOpportunityCommand,
  type RequestOpportunityDecisionCommand,
  type RecordOpportunityDecisionCommand,
} from '@mje/contracts';
export type OpportunityAction =
  | { kind: 'create'; body: CreateOpportunityCommand }
  | { kind: 'update'; body: UpdateOpportunityCommand }
  | { kind: 'request'; body: RequestOpportunityDecisionCommand }
  | { kind: 'decide'; body: RecordOpportunityDecisionCommand };
export interface OpportunityDraft {
  accountId: string;
  opportunityId: string;
  kind: OpportunityAction['kind'];
  baseline: OpportunityItemDto | null;
  baselineFacts: OpportunityFacts;
  facts: OpportunityFacts;
  code: string;
  newFact: string;
  noMaterialChange: boolean;
  evidence: string;
  obstacle: string;
  reason: string;
  nextMode: 'KEEP' | 'REPLACE' | 'COMPLETE_AND_ADD';
  nextId: string;
  nextAction: string;
  nextOwner: string | null;
  nextDue: OpportunityValue;
  requestedPerson: string | null;
  explanation: string;
  requestDue: OpportunityValue;
  requestId: string;
  decisionKind: 'CONTINUE' | 'PAUSE' | 'EXIT';
  actualPerson: string;
  decisionText: string;
  decisionBasis: string;
  resumeCondition: string;
  reviewOn: OpportunityValue;
  exitReason: string;
  reentryCondition: string;
  proxyBasis: string;
  proxyFrom: OpportunityValue;
  proxyUntil: OpportunityValue;
  occurredAt: string;
  timezone: string;
  businessDate: string;
  sourceDocumentId: string | null;
  sourceReference: string;
  sourceLocation: string;
  unresolved: OpportunityAction | null;
}
const unknown = (): OpportunityValue => ({ state: 'UNKNOWN', value: null });
/** Hidden text is never invented as an old value. The UI disables the corresponding whole-item editor. */
export function editableFacts(item: OpportunityItemDto): OpportunityFacts {
  const f = item.revision.facts;
  return {
    name: f.name,
    businessLine: f.businessLine,
    customerGroup: f.customerGroup,
    informationOwnerPersonId: f.informationOwnerPersonId,
    assistantPersonIds: f.assistantPersonIds,
    parties: f.parties,
    ownerProject: {
      ...f.ownerProject,
      conditions: f.ownerProject.conditions.map((x) => ({
        ...x,
        basis: x.basis.visibility === 'visible' ? x.basis.value : null,
      })),
    },
    proposedScopes: f.proposedScopes,
    dates: f.dates,
    stageRaw: f.stageRaw,
    probabilityRaw:
      f.probabilityRaw.visibility === 'visible'
        ? f.probabilityRaw.value
        : unknown(),
    mustWinRaw:
      f.mustWinRaw.visibility === 'visible' ? f.mustWinRaw.value : unknown(),
    internalNote:
      f.internalNote.visibility === 'visible'
        ? f.internalNote.value
        : { state: 'BLANK', value: null },
  };
}
export function newDraft(
  accountId: string,
  personId: string,
  kind: OpportunityAction['kind'],
  uuid: () => string,
  item: OpportunityItemDto | null = null,
): OpportunityDraft {
  const facts = item ? editableFacts(item) : blankOpportunityFacts('');
  return {
    accountId,
    opportunityId: item?.id ?? uuid(),
    kind,
    baseline: item ? structuredClone(item) : null,
    baselineFacts: structuredClone(facts),
    facts: structuredClone(facts),
    code: '',
    newFact: '',
    noMaterialChange: false,
    evidence: '',
    obstacle: '',
    reason: '',
    nextMode: 'KEEP',
    nextId: uuid(),
    nextAction: '',
    nextOwner: null,
    nextDue: unknown(),
    requestedPerson: null,
    explanation: '',
    requestDue: unknown(),
    requestId: uuid(),
    decisionKind: 'CONTINUE',
    actualPerson: personId,
    decisionText: '',
    decisionBasis: '',
    resumeCondition: '',
    reviewOn: unknown(),
    exitReason: '',
    reentryCondition: '',
    proxyBasis: '',
    proxyFrom: unknown(),
    proxyUntil: unknown(),
    occurredAt: '',
    timezone: '',
    businessDate: '',
    sourceDocumentId: null,
    sourceReference: '',
    sourceLocation: '',
    unresolved: null,
  };
}
export const changedFields = (d: OpportunityDraft) =>
  (Object.keys(d.facts) as (keyof OpportunityFacts)[]).filter(
    (k) => JSON.stringify(d.facts[k]) !== JSON.stringify(d.baselineFacts[k]),
  );
export function freezeAction(
  d: OpportunityDraft,
  key: string,
): OpportunityAction {
  const base = { opportunityId: d.opportunityId, clientMutationId: key },
    sources =
      d.sourceReference || d.sourceLocation || d.sourceDocumentId
        ? [
            {
              sourceDocumentId: d.sourceDocumentId,
              reference: d.sourceReference,
              location: d.sourceLocation,
            },
          ]
        : [],
    occurrence = {
      occurredAt: d.occurredAt || null,
      timezone: d.timezone || null,
      businessDate: d.businessDate || null,
    };
  if (d.kind === 'create')
    return {
      kind: 'create',
      body: parseCreateOpportunity({
        ...base,
        expectedVersion: 0,
        code: d.code || null,
        facts: d.facts,
        sources,
      }),
    };
  if (!d.baseline) throw new Error('NO_BASELINE');
  if (d.kind === 'update') {
    const changes = changedFields(d).map((field) => ({
      field,
      before: d.baselineFacts[field],
      after: d.facts[field],
      reason: d.reason,
      basis: null,
    })) as OpportunityFieldChange[];
    return {
      kind: 'update',
      body: parseUpdateOpportunity({
        ...base,
        expectedVersion: changes.length ? d.baseline.version : null,
        newFact: d.noMaterialChange ? null : d.newFact,
        noMaterialChange: d.noMaterialChange,
        evidence: d.evidence || null,
        obstacle: d.obstacle || null,
        occurrence,
        sources,
        changes,
        nextStep:
          d.nextMode === 'KEEP'
            ? { mode: 'KEEP' }
            : {
                mode: d.nextMode,
                baseStepId: d.baseline.nextStep?.id ?? null,
                next: {
                  id: d.nextId,
                  action: d.nextAction,
                  ownerPersonId: d.nextOwner,
                  dueOn: d.nextDue,
                },
              },
      }),
    };
  }
  if (d.kind === 'request')
    return {
      kind: 'request',
      body: parseRequestOpportunityDecision({
        ...base,
        expectedRequestId: d.baseline.pendingRequest?.id ?? null,
        requestId: d.requestId,
        requestedPersonId: d.requestedPerson,
        explanation: d.explanation,
        dueOn: d.requestDue,
        sources,
      }),
    };
  return {
    kind: 'decide',
    body: parseRecordOpportunityDecision({
      ...base,
      expectedDecisionVersion: d.baseline.decisionVersion,
      expectedRequestId: d.baseline.pendingRequest?.id ?? null,
      actualDecisionPersonId: d.actualPerson,
      decision: {
        kind: d.decisionKind,
        resumeCondition:
          d.decisionKind === 'PAUSE' ? d.resumeCondition || null : null,
        reviewOn: d.decisionKind === 'PAUSE' ? d.reviewOn : unknown(),
        exitReason: d.decisionKind === 'EXIT' ? d.exitReason || null : null,
        reentryCondition:
          d.decisionKind === 'EXIT' ? d.reentryCondition || null : null,
      },
      recordText: d.decisionText,
      basis: d.decisionBasis,
      occurrence,
      proxy: d.proxyBasis
        ? { basis: d.proxyBasis, from: d.proxyFrom, until: d.proxyUntil }
        : null,
      sources,
    }),
  };
}
export function parseAction(raw: OpportunityAction): OpportunityAction {
  switch (raw.kind) {
    case 'create':
      return { kind: raw.kind, body: parseCreateOpportunity(raw.body) };
    case 'update':
      return { kind: raw.kind, body: parseUpdateOpportunity(raw.body) };
    case 'request':
      return {
        kind: raw.kind,
        body: parseRequestOpportunityDecision(raw.body),
      };
    case 'decide':
      return { kind: raw.kind, body: parseRecordOpportunityDecision(raw.body) };
  }
}
export function rebase(
  d: OpportunityDraft,
  latest: OpportunityItemDto,
  choices: Partial<Record<keyof OpportunityFacts, 'mine' | 'latest'>>,
  step: OpportunityDraft['nextMode'] | null,
): OpportunityDraft {
  if (latest.id !== d.opportunityId) throw new Error('NO_BASELINE');
  const fields = changedFields(d),
    base = editableFacts(latest),
    facts = structuredClone(base);
  for (const field of fields) {
    if (!choices[field]) throw new Error('NEED_CHOICE');
    if (choices[field] === 'mine')
      Object.assign(facts, { [field]: structuredClone(d.facts[field]) });
  }
  if (d.kind === 'update' && !step) throw new Error('NEED_STEP_CHOICE');
  return {
    ...d,
    baseline: structuredClone(latest),
    baselineFacts: structuredClone(base),
    facts,
    nextMode: step ?? d.nextMode,
    unresolved: null,
  };
}
export class OpportunityDrafts {
  constructor(
    private readonly storage: Pick<
      Storage,
      'getItem' | 'setItem' | 'removeItem'
    >,
    readonly accountId: string,
  ) {}
  private key() {
    return `mje-opportunity-draft-v1:${this.accountId}`;
  }
  save(d: OpportunityDraft) {
    if (d.accountId !== this.accountId) throw new Error('ACCOUNT_CHANGED');
    this.storage.setItem(this.key(), JSON.stringify(d));
  }
  load(): OpportunityDraft | null {
    try {
      const raw = this.storage.getItem(this.key());
      if (!raw) return null;
      const d = JSON.parse(raw) as OpportunityDraft;
      if (
        d.accountId !== this.accountId ||
        !d.facts ||
        !d.baselineFacts ||
        !['create', 'update', 'request', 'decide'].includes(d.kind) ||
        typeof d.opportunityId !== 'string'
      )
        return null;
      if (d.unresolved) d.unresolved = parseAction(d.unresolved);
      return d;
    } catch {
      return null;
    }
  }
  remove() {
    this.storage.removeItem(this.key());
  }
}
