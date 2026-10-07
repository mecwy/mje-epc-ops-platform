import { describe, it, expect } from 'vitest';
import {
  blankOpportunityFacts,
  type UpdateOpportunityCommand,
} from '@mje/contracts';
import {
  allows,
  canCreate,
  capabilities,
  dateChange,
  validateUpdate,
  restrictedFactsChanged,
  type OpportunityGrant,
} from './rules.js';
const id = '11111111-1111-4111-8111-111111111111';
const facts = () => ({
  ...blankOpportunityFacts('TEST lead'),
  businessLine: { state: 'VALUE' as const, value: 'TEST A' },
});
const update = (): UpdateOpportunityCommand => ({
  opportunityId: id,
  clientMutationId: id,
  expectedVersion: null,
  newFact: null,
  noMaterialChange: true,
  evidence: null,
  obstacle: null,
  occurrence: { occurredAt: null, timezone: null, businessDate: null },
  sources: [],
  changes: [],
  nextStep: { mode: 'KEEP' },
});
describe('opportunity command invariants', () => {
  it('exact-opportunity maintenance never authorizes another creation', () => {
    const grant: OpportunityGrant = {
      capability: 'opportunity.maintain',
      scope: 'OPPORTUNITY',
      opportunityId: id,
      businessLine: null,
    };
    expect(canCreate([grant])).toBe(false);
    expect(
      canCreate([
        { ...grant, scope: 'ORG', source: 'system:opportunity.create' },
      ]),
    ).toBe(false);
    expect(canCreate([{ ...grant, scope: 'ORG', opportunityId: null }])).toBe(
      true,
    );
    expect(
      canCreate([
        {
          ...grant,
          scope: 'BUSINESS_LINE',
          opportunityId: null,
          businessLine: 'TEST A',
        },
      ]),
    ).toBe(false);
  });

  it('requires protected-text rights only for actual basis changes, including moves between condition IDs', () => {
    const before = facts(),
      after = structuredClone(before);
    after.ownerProject.conditions.push({
      id,
      summary: 'TEST permit',
      responsibleRaw: { state: 'UNKNOWN', value: null },
      status: 'UNKNOWN',
      basis: null,
    });
    expect(restrictedFactsChanged(before, after)).toBe(false);
    after.ownerProject.conditions[0]!.basis = 'TEST protected basis';
    expect(restrictedFactsChanged(before, after)).toBe(true);
    const reordered = structuredClone(after);
    reordered.ownerProject.conditions.unshift({
      id: '22222222-2222-4222-8222-222222222222',
      summary: 'TEST other',
      responsibleRaw: { state: 'UNKNOWN', value: null },
      status: 'UNKNOWN',
      basis: null,
    });
    expect(restrictedFactsChanged(after, reordered)).toBe(false);
    reordered.ownerProject.conditions[1]!.id =
      '33333333-3333-4333-8333-333333333333';
    expect(restrictedFactsChanged(after, reordered)).toBe(true);
  });
  it('allows scopes independently for each explicit capability and never infers maintain from amount', () => {
    const f = facts();
    for (const scope of ['ORG', 'BUSINESS_LINE', 'OPPORTUNITY'] as const) {
      const grant: OpportunityGrant = {
        capability: 'opportunity.amount',
        scope,
        businessLine: 'TEST A',
        opportunityId: id,
      };
      expect(allows([grant], 'opportunity.amount', id, f)).toBe(true);
      expect(capabilities([grant], id, f).maintain).toBe(false);
      expect(capabilities([grant], id, f).amount).toBe(false);
    }
    expect(
      allows(
        [
          {
            capability: 'opportunity.view',
            scope: 'BUSINESS_LINE',
            businessLine: 'TEST B',
            opportunityId: null,
          },
        ],
        'opportunity.view',
        id,
        f,
      ),
    ).toBe(false);
  });
  it('distinguishes actual rescheduling from certainty changes', () => {
    const b = facts().dates,
      a = structuredClone(b);
    a.expectedSigning = { state: 'VALUE', value: '2026-10-03' };
    expect(dateChange(b, a)).toBe('CERTAINTY');
    const c = structuredClone(a);
    c.expectedSigning.value = '2026-10-04';
    expect(dateChange(a, c)).toBe('RESCHEDULE');
    expect(dateChange(a, a)).toBeNull();
  });
  it('rejects stale compound baseline without mutating input', () => {
    const f = facts(),
      before = structuredClone(f);
    const c = update();
    c.expectedVersion = 1;
    c.changes = [
      {
        field: 'name',
        before: 'TEST stale',
        after: 'TEST new',
        reason: 'TEST correction',
        basis: null,
      },
    ];
    expect(() => validateUpdate(c, 1, f, null, [])).toThrow('FIELD_CONFLICT');
    expect(f).toEqual(before);
    c.expectedVersion = 0;
    expect(() => validateUpdate(c, 1, f, null, [])).toThrow('VERSION_CONFLICT');
  });
  it('requires reason for unknown-to-specific date changes', () => {
    const f = facts(),
      c = update(),
      after = structuredClone(f.dates);
    after.expectedSigning = { state: 'VALUE', value: '2026-10-03' };
    c.expectedVersion = 1;
    c.changes = [
      { field: 'dates', before: f.dates, after, reason: '', basis: null },
    ];
    expect(() => validateUpdate(c, 1, f, null, [])).toThrow('REASON_REQUIRED');
  });
  it('explicit KEEP accepts append after another next step changed', () => {
    const c = update(),
      f = facts(),
      step = {
        id,
        action: 'TEST newer step',
        ownerPersonId: null,
        dueOn: { state: 'UNKNOWN' as const, value: null },
        createdAt: '2026-10-03T00:00:00Z',
        completed: false,
      };
    expect(validateUpdate(c, 9, f, step, [id])).toEqual(f);
    c.nextStep = {
      mode: 'REPLACE',
      baseStepId: null,
      next: { ...step, id: '22222222-2222-4222-8222-222222222222' },
    };
    expect(() => validateUpdate(c, 9, f, step, [id])).toThrow('STEP_CONFLICT');
  });
  it('requires evidence for a substantive fact and prevents reused step identities', () => {
    const c = update();
    c.newFact = 'TEST change';
    c.noMaterialChange = false;
    expect(() => validateUpdate(c, 1, facts(), null, [])).toThrow(
      'EVIDENCE_REQUIRED',
    );
    c.evidence = 'TEST meeting';
    c.nextStep = {
      mode: 'REPLACE',
      baseStepId: null,
      next: {
        id,
        action: 'TEST next',
        ownerPersonId: null,
        dueOn: { state: 'UNKNOWN', value: null },
      },
    };
    expect(() => validateUpdate(c, 1, facts(), null, [id])).toThrow(
      'IDENTITY_EXISTS',
    );
  });
});
