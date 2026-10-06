import { isDeepStrictEqual } from 'node:util';
import type {
  OpportunityFacts,
  OpportunityDecisionState,
  OpportunityNextStepDto,
  UpdateOpportunityCommand,
  OpportunityProjected,
} from '@mje/contracts';
export type OpportunityCapability =
  | 'opportunity.view'
  | 'opportunity.maintain'
  | 'opportunity.amount'
  | 'opportunity.internal'
  | 'opportunity.decide';
export interface OpportunityGrant {
  capability: OpportunityCapability;
  scope: 'ORG' | 'BUSINESS_LINE' | 'OPPORTUNITY';
  businessLine: string | null;
  opportunityId: string | null;
}
export class OpportunityError extends Error {
  constructor(
    public readonly code:
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'VERSION_CONFLICT'
      | 'FIELD_CONFLICT'
      | 'STEP_CONFLICT'
      | 'REQUEST_CONFLICT'
      | 'DECISION_CONFLICT'
      | 'SOURCE_INVALID'
      | 'IDENTITY_EXISTS'
      | 'REASON_REQUIRED'
      | 'EVIDENCE_REQUIRED'
      | 'PROXY_INVALID',
  ) {
    super(code);
  }
}
export function allows(
  g: OpportunityGrant[],
  cap: OpportunityCapability,
  id: string,
  facts: OpportunityFacts,
) {
  return g.some(
    (x) =>
      x.capability === cap &&
      (x.scope === 'ORG' ||
        (x.scope === 'OPPORTUNITY' && x.opportunityId === id) ||
        (x.scope === 'BUSINESS_LINE' &&
          facts.businessLine.state === 'VALUE' &&
          facts.businessLine.value === x.businessLine)),
  );
}
export const canCreate = (g: OpportunityGrant[]) =>
  g.some((x) => x.capability === 'opportunity.maintain');
export function capabilities(
  g: OpportunityGrant[],
  id: string,
  f: OpportunityFacts,
) {
  const view = allows(g, 'opportunity.view', id, f);
  const has = (c: OpportunityCapability) => view && allows(g, c, id, f);
  return {
    view,
    maintain: has('opportunity.maintain'),
    amount: has('opportunity.amount'),
    restrictedText: has('opportunity.amount') && has('opportunity.internal'),
    decide: has('opportunity.decide'),
  };
}
export function project<T>(
  allowed: boolean,
  value: T,
): OpportunityProjected<T> {
  return allowed
    ? { visibility: 'visible', value }
    : { visibility: 'restricted' };
}
export const initialDecision = (): OpportunityDecisionState => ({
  kind: 'CONTINUE',
  resumeCondition: null,
  reviewOn: { state: 'UNKNOWN', value: null },
  exitReason: null,
  reentryCondition: null,
});
export function dateChange(
  before: OpportunityFacts['dates'],
  after: OpportunityFacts['dates'],
): 'RESCHEDULE' | 'CERTAINTY' | null {
  const b = before.expectedSigning,
    a = after.expectedSigning;
  if (isDeepStrictEqual(b, a)) return null;
  return b.state === 'VALUE' && a.state === 'VALUE'
    ? 'RESCHEDULE'
    : 'CERTAINTY';
}
function blank(x: unknown): boolean {
  if (x === null || x === '') return true;
  if (Array.isArray(x)) return x.length === 0;
  if (typeof x === 'object' && x !== null && 'state' in x)
    return x.state === 'BLANK' || x.state === 'NOT_STATED';
  return false;
}
export function validateUpdate(
  command: UpdateOpportunityCommand,
  version: number,
  facts: OpportunityFacts,
  step: OpportunityNextStepDto | null,
  usedStepIds: readonly string[],
): OpportunityFacts {
  if (command.changes.length && command.expectedVersion !== version)
    throw new OpportunityError('VERSION_CONFLICT');
  if (command.newFact && !command.evidence?.trim() && !command.sources.length)
    throw new OpportunityError('EVIDENCE_REQUIRED');
  const next = structuredClone(facts);
  for (const change of command.changes) {
    if (!isDeepStrictEqual(change.before, facts[change.field]))
      throw new OpportunityError('FIELD_CONFLICT');
    if (
      !isDeepStrictEqual(change.before, change.after) &&
      !blank(change.before) &&
      !change.reason.trim()
    )
      throw new OpportunityError('REASON_REQUIRED');
    // The parser preserves the field/value union; this assignment is scoped to that key.
    Object.assign(next, { [change.field]: structuredClone(change.after) });
  }
  if (command.nextStep.mode !== 'KEEP') {
    if (command.nextStep.baseStepId !== (step?.id ?? null))
      throw new OpportunityError('STEP_CONFLICT');
    if (usedStepIds.includes(command.nextStep.next.id))
      throw new OpportunityError('IDENTITY_EXISTS');
    if (command.nextStep.mode === 'COMPLETE_AND_ADD' && !step)
      throw new OpportunityError('STEP_CONFLICT');
  }
  return next;
}
/** Ordinary maintenance of any restricted text needs both read capabilities. Request/decision are separate exceptions. */
export function restrictedFactsChanged(
  before: OpportunityFacts,
  after: OpportunityFacts,
): boolean {
  const basis = (facts: OpportunityFacts) =>
    facts.ownerProject.conditions
      .filter((c) => c.basis !== null)
      .map((c) => ({ id: c.id, basis: c.basis }))
      .sort((a, b) => a.id.localeCompare(b.id));
  return !isDeepStrictEqual(
    [before.internalNote, basis(before)],
    [after.internalNote, basis(after)],
  );
}
