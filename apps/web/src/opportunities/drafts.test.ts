import { describe, it, expect } from 'vitest';
import { blankOpportunityFacts, type OpportunityItemDto } from '@mje/contracts';
import { newDraft, freezeAction, rebase, OpportunityDrafts } from './drafts.js';
const uuid = () => '11111111-1111-4111-8111-111111111111';
function item(version = 1): OpportunityItemDto {
  const f = blankOpportunityFacts('TEST lead');
  return {
    id: uuid(),
    code: 'TEST ONE',
    version,
    revision: {
      n: 1,
      facts: {
        ...f,
        ownerProject: { ...f.ownerProject, conditions: [] },
        probabilityRaw: { visibility: 'visible', value: f.probabilityRaw },
        mustWinRaw: { visibility: 'visible', value: f.mustWinRaw },
        internalNote: { visibility: 'restricted' },
      },
      sources: { visibility: 'restricted' },
      recordedAt: '2026-10-03T00:00:00Z',
      recordedByAccountId: 'TEST account A',
      recordedByPersonId: 'TEST person',
    },
    effectiveDecision: {
      kind: 'CONTINUE',
      resumeCondition: null,
      reviewOn: { state: 'UNKNOWN', value: null },
      exitReason: null,
      reentryCondition: null,
    },
    decisionVersion: 0,
    decisionIsDefault: true,
    pendingRequest: null,
    nextStep: null,
    lastContact: null,
    lastSubstantiveProgress: null,
    rescheduleCount: 0,
    capabilities: {
      maintain: true,
      amount: false,
      restrictedText: false,
      decide: false,
    },
  };
}
describe('opportunity draft ownership and baselines', () => {
  it('isolates same-Person accounts and preserves unresolved fixed payload', () => {
    const map = new Map<string, string>(),
      storage = {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => {
          map.set(k, v);
        },
        removeItem: (k: string) => {
          map.delete(k);
        },
      };
    const d = newDraft('TEST account A', 'TEST person', 'create', uuid);
    d.facts.name = 'TEST local sentence';
    d.unresolved = freezeAction(d, uuid());
    const a = new OpportunityDrafts(storage, 'TEST account A'),
      b = new OpportunityDrafts(storage, 'TEST account B');
    a.save(d);
    expect(b.load()).toBeNull();
    expect(() => b.save(d)).toThrow('ACCOUNT_CHANGED');
    expect(a.load()?.unresolved).toEqual(d.unresolved);
  });
  it('freezes all source/time/field/step baselines with the original expected version', () => {
    const original = item(7),
      d = newDraft('TEST account A', 'TEST person', 'update', uuid, original);
    d.facts.name = 'TEST changed';
    d.reason = 'TEST correction';
    d.noMaterialChange = true;
    d.occurredAt = '2026-10-03T08:00:00Z';
    d.timezone = 'Europe/Belgrade';
    d.businessDate = '2026-10-03';
    const action = freezeAction(d, uuid());
    d.facts.name = 'TEST edited later';
    d.occurredAt = '2026-10-04T08:00:00Z';
    expect(action.kind).toBe('update');
    if (action.kind === 'update') {
      expect(action.body.expectedVersion).toBe(7);
      expect(action.body.changes[0]?.before).toBe('TEST lead');
      expect(action.body.changes[0]?.after).toBe('TEST changed');
      expect(action.body.occurrence.occurredAt).toBe('2026-10-03T08:00:00Z');
      expect(action.body.nextStep).toEqual({ mode: 'KEEP' });
    }
  });
  it('never silently adopts latest field or step baselines', () => {
    const d = newDraft('TEST account A', 'TEST person', 'update', uuid, item());
    d.facts.name = 'TEST mine';
    const latest = item(9);
    latest.revision.facts.name = 'TEST theirs';
    latest.nextStep = {
      id: '22222222-2222-4222-8222-222222222222',
      action: 'TEST changed step',
      ownerPersonId: null,
      dueOn: { state: 'UNKNOWN', value: null },
      createdAt: '2026-10-03T09:00:00Z',
      completed: false,
    };
    expect(() => rebase(d, latest, {}, 'KEEP')).toThrow('NEED_CHOICE');
    expect(() => rebase(d, latest, { name: 'mine' }, null)).toThrow(
      'NEED_STEP_CHOICE',
    );
    const rebased = rebase(d, latest, { name: 'mine' }, 'REPLACE');
    expect(rebased.facts.name).toBe('TEST mine');
    expect(rebased.baselineFacts.name).toBe('TEST theirs');
    expect(rebased.baseline?.version).toBe(9);
    expect(rebased.baseline?.nextStep?.id).toBe(latest.nextStep.id);
    expect(d.baseline?.version).toBe(1);
  });
});
