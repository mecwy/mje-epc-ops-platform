import type {
  OpportunityFacts,
  OpportunityFactsDto,
  OpportunityFieldValueDto,
  OpportunityHistoryDto,
  OpportunityItemDto,
  OpportunityUpdateDto,
  OpportunityRequestDto,
  OpportunityRevisionDto,
  OpportunityNextStepDto,
  OpportunityOwnerProject,
} from '@mje/contracts';
import {
  capabilities,
  dateChange,
  initialDecision,
  project,
  type OpportunityGrant,
} from './rules.js';
import { state, type StoredOpportunity, type StoredRecord } from './data.js';
function ownerProject(
  p: OpportunityOwnerProject,
  text: boolean,
): OpportunityFactsDto['ownerProject'] {
  return {
    projectType: p.projectType,
    country: p.country,
    city: p.city,
    reportedScale: p.reportedScale,
    conditions: p.conditions.map((x) => ({
      id: x.id,
      summary: x.summary,
      responsibleRaw: x.responsibleRaw,
      status: x.status,
      basis: project(text, x.basis),
    })),
  };
}
export function factsDto(
  f: OpportunityFacts,
  text: boolean,
): OpportunityFactsDto {
  return {
    name: f.name,
    businessLine: f.businessLine,
    customerGroup: f.customerGroup,
    informationOwnerPersonId: f.informationOwnerPersonId,
    assistantPersonIds: f.assistantPersonIds,
    parties: f.parties,
    ownerProject: ownerProject(f.ownerProject, text),
    proposedScopes: f.proposedScopes,
    dates: f.dates,
    stageRaw: f.stageRaw,
    probabilityRaw: project(true, f.probabilityRaw),
    mustWinRaw: project(true, f.mustWinRaw),
    internalNote: project(text, f.internalNote),
  };
}
function fieldValue(
  key: keyof OpportunityFacts,
  value: OpportunityFacts[keyof OpportunityFacts],
  text: boolean,
): OpportunityFieldValueDto {
  if (key === 'ownerProject')
    return ownerProject(value as OpportunityOwnerProject, text);
  return value as Exclude<
    OpportunityFieldValueDto,
    OpportunityFactsDto['ownerProject']
  >;
}
function requestDto(
  r: Extract<StoredRecord, { kind: 'REQUEST' }>,
  text: boolean,
): OpportunityRequestDto {
  return {
    id: r.command.requestId,
    requestedPersonId: r.command.requestedPersonId,
    explanation: project(text, r.command.explanation),
    dueOn: r.command.dueOn,
    raisedByPersonId: r.recordedByPersonId,
    recordedByAccountId: r.recordedByAccountId,
    recordedAt: r.recordedAt,
  };
}
/** The only content projection. Detail/list/history/worklists share it and never return a stored payload. */
export function projection(
  row: StoredOpportunity,
  g: OpportunityGrant[],
): { item: OpportunityItemDto; history: OpportunityHistoryDto } | null {
  const s = state(row),
    caps = capabilities(g, row.id, s.facts);
  if (!caps.view) return null;
  const history: OpportunityHistoryDto = {
    revisions: [],
    updates: [],
    requests: [],
    decisions: [],
  };
  let next: OpportunityNextStepDto | null = null,
    request: OpportunityRequestDto | null = null,
    decision = initialDecision(),
    reschedules = 0;
  for (const r of row.records) {
    if (
      r.kind === 'CREATE' ||
      (r.kind === 'UPDATE' && r.command.changes.length)
    ) {
      const revision: OpportunityRevisionDto = {
        n: history.revisions.length + 1,
        facts: factsDto(r.facts, caps.restrictedText),
        sources: project(caps.restrictedText && r.sourcesEligible, r.sources),
        recordedAt: r.recordedAt,
        recordedByAccountId: r.recordedByAccountId,
        recordedByPersonId: r.recordedByPersonId,
      };
      history.revisions.push(revision);
    }
    if (r.kind === 'UPDATE') {
      const c = r.command,
        completedStepId =
          c.nextStep.mode === 'COMPLETE_AND_ADD' ? (next?.id ?? null) : null;
      if (c.nextStep.mode !== 'KEEP')
        next = {
          id: c.nextStep.next.id,
          action: c.nextStep.next.action,
          ownerPersonId: c.nextStep.next.ownerPersonId,
          dueOn: c.nextStep.next.dueOn,
          createdAt: r.recordedAt,
          completed: false,
        };
      const changes = c.changes.map((change) => {
        const date =
          change.field === 'dates'
            ? dateChange(change.before, change.after)
            : null;
        if (date === 'RESCHEDULE') reschedules++;
        const show = change.field !== 'internalNote' || caps.restrictedText;
        return {
          field: change.field,
          before: project(
            show,
            fieldValue(change.field, change.before, caps.restrictedText),
          ),
          after: project(
            show,
            fieldValue(change.field, change.after, caps.restrictedText),
          ),
          reason: project(caps.restrictedText, change.reason),
          basis: project(caps.restrictedText, change.basis),
          dateChange: date,
        };
      });
      const update: OpportunityUpdateDto = {
        id: r.id,
        n: history.updates.length + 1,
        newFact: c.newFact,
        noMaterialChange: c.noMaterialChange,
        evidence: project(caps.restrictedText, c.evidence),
        obstacle: project(caps.restrictedText, c.obstacle),
        recordedAt: r.recordedAt,
        recordedByAccountId: r.recordedByAccountId,
        recordedByPersonId: r.recordedByPersonId,
        occurrence: c.occurrence,
        sources: project(caps.restrictedText && r.sourcesEligible, r.sources),
        changes,
        nextStepMode: c.nextStep.mode,
        nextStep: next ? structuredClone(next) : null,
        completedStepId,
      };
      history.updates.push(update);
    }
    if (r.kind === 'REQUEST') {
      request = requestDto(r, caps.restrictedText);
      history.requests.push(request);
    }
    if (r.kind === 'DECISION') {
      const c = r.command;
      history.decisions.push({
        n: history.decisions.length + 1,
        current: c.decision,
        previous: decision,
        actualDecisionPersonId: c.actualDecisionPersonId,
        recordedByAccountId: r.recordedByAccountId,
        recordedByPersonId: r.recordedByPersonId,
        recordedAt: r.recordedAt,
        occurrence: c.occurrence,
        recordText: project(caps.restrictedText, c.recordText),
        basis: project(caps.restrictedText, c.basis),
        proxy: project(caps.restrictedText, c.proxy),
        resolvedRequest: request,
      });
      decision = c.decision;
      request = null;
    }
  }
  return {
    item: {
      id: row.id,
      code: row.code,
      version: row.version,
      revision: history.revisions.at(-1)!,
      effectiveDecision: decision,
      decisionVersion: history.decisions.length,
      decisionIsDefault: !history.decisions.length,
      pendingRequest: request,
      nextStep: next,
      lastContact: history.updates.at(-1) ?? null,
      lastSubstantiveProgress:
        history.updates.findLast((x) => !x.noMaterialChange) ?? null,
      rescheduleCount: reschedules,
      capabilities: {
        maintain: caps.maintain,
        amount: caps.amount,
        restrictedText: caps.restrictedText,
        decide: caps.decide,
      },
    },
    history,
  };
}
