import { describe, it, expect } from 'vitest';
import {
  blankOpportunityFacts,
  parseCreateOpportunity,
  parseUpdateOpportunity,
  parseRecordOpportunityDecision,
} from './opportunity-commands.js';
const opp = '11111111-1111-4111-8111-111111111111',
  mutation = '22222222-2222-4222-8222-222222222222';
const create = () => ({
  opportunityId: opp,
  clientMutationId: mutation,
  expectedVersion: 0,
  code: null,
  facts: blankOpportunityFacts('TEST one sentence'),
  sources: [],
});
const update = () => ({
  opportunityId: opp,
  clientMutationId: mutation,
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
describe('opportunity command boundary', () => {
  it('one sentence keeps unassigned owners, unknown dates and scale instead of zeros', () => {
    const c = parseCreateOpportunity(create());
    expect(c.facts.informationOwnerPersonId).toBeNull();
    expect(c.facts.dates.expectedSigning).toEqual({
      state: 'UNKNOWN',
      value: null,
    });
    expect(c.facts.ownerProject.reportedScale.value).toEqual({
      state: 'UNKNOWN',
      value: null,
    });
    expect(c.code).toBeNull();
  });
  it.each(['VALUE', 'BLANK', 'UNKNOWN', 'NA', 'NOT_STATED'])(
    'preserves %s with explicit zero distinct from absence',
    (state) => {
      const c = create();
      c.facts.ownerProject.reportedScale.value = {
        state: state as 'VALUE',
        value: state === 'VALUE' ? '0.000000' : null,
      };
      c.facts.ownerProject.reportedScale.unitRaw = 'MWp';
      expect(
        parseCreateOpportunity(c).facts.ownerProject.reportedScale.value,
      ).toEqual(c.facts.ownerProject.reportedScale.value);
    },
  );
  it.each(['1e3', 'NaN', '-1', '123456789012345.123456', '1.1234567'])(
    'rejects invalid quantity %s',
    (raw) => {
      const c = create();
      c.facts.ownerProject.reportedScale.value = { state: 'VALUE', value: raw };
      c.facts.ownerProject.reportedScale.unitRaw = 'MWp';
      expect(() => parseCreateOpportunity(c)).toThrow();
    },
  );
  it('rejects numeric quantity and known quantity without unit', () => {
    const c = create();
    c.facts.ownerProject.reportedScale.value = { state: 'VALUE', value: '0' };
    expect(() => parseCreateOpportunity(c)).toThrow();
    expect(() =>
      parseCreateOpportunity({
        ...c,
        facts: {
          ...c.facts,
          ownerProject: {
            ...c.facts.ownerProject,
            reportedScale: {
              ...c.facts.ownerProject.reportedScale,
              value: { state: 'VALUE', value: 0 },
            },
          },
        },
      }),
    ).toThrow();
  });
  it.each(['orgId', 'role', 'direction', 'awardedAmount', 'contractId'])(
    'rejects client field %s',
    (key) =>
      expect(() =>
        parseCreateOpportunity({ ...create(), [key]: 'TEST' }),
      ).toThrow(),
  );
  it('requires complete changed-field before values and a version', () => {
    const change = {
      field: 'name',
      before: 'TEST old',
      after: 'TEST new',
      reason: 'TEST correction',
      basis: null,
    };
    expect(() =>
      parseUpdateOpportunity({ ...update(), changes: [change] }),
    ).toThrow();
    expect(() =>
      parseUpdateOpportunity({
        ...update(),
        expectedVersion: 1,
        changes: [{ ...change, before: undefined }],
      }),
    ).toThrow();
    expect(
      parseUpdateOpportunity({
        ...update(),
        expectedVersion: 1,
        changes: [change],
      }).changes,
    ).toEqual([change]);
  });
  it('KEEP needs no step baseline; replacement requires an explicit baseline and stable identity', () => {
    expect(parseUpdateOpportunity(update()).nextStep).toEqual({ mode: 'KEEP' });
    const next = {
      id: mutation,
      action: 'TEST follow up',
      ownerPersonId: null,
      dueOn: { state: 'UNKNOWN', value: null },
    };
    expect(() =>
      parseUpdateOpportunity({
        ...update(),
        nextStep: { mode: 'REPLACE', next },
      }),
    ).toThrow();
    expect(
      parseUpdateOpportunity({
        ...update(),
        nextStep: { mode: 'REPLACE', baseStepId: null, next },
      }).nextStep,
    ).toEqual({ mode: 'REPLACE', baseStepId: null, next });
  });
  it.each([
    '2026-02-30T09:00:00Z',
    '2026-10-03T24:00:00Z',
    '2026-10-03T12:60:00Z',
    '2026-10-03T12:00:00+02:00',
  ])('rejects rolled or non-UTC occurrence %s', (at) => {
    expect(() =>
      parseUpdateOpportunity({
        ...update(),
        occurrence: {
          occurredAt: at,
          timezone: 'Europe/Belgrade',
          businessDate: '2026-10-03',
        },
      }),
    ).toThrow();
  });
  it('keeps occurrence/timezone/business day independent of receipt date', () => {
    const o = {
      occurredAt: '2026-10-02T22:30:00.1Z',
      timezone: 'Europe/Belgrade',
      businessDate: '2026-10-03',
    };
    expect(
      parseUpdateOpportunity({ ...update(), occurrence: o }).occurrence,
    ).toEqual(o);
  });
  it('requires exactly one fact or no-change choice', () => {
    expect(() =>
      parseUpdateOpportunity({ ...update(), noMaterialChange: false }),
    ).toThrow();
    expect(() =>
      parseUpdateOpportunity({ ...update(), newFact: 'TEST fact' }),
    ).toThrow();
  });
  it('does not accept a commercial decision through ordinary update', () =>
    expect(() =>
      parseUpdateOpportunity({ ...update(), decision: { kind: 'EXIT' } }),
    ).toThrow());
  it('rejects exit without reason and a continue decision carrying obsolete pause data', () => {
    const c = {
      opportunityId: opp,
      clientMutationId: mutation,
      expectedDecisionVersion: 0,
      expectedRequestId: null,
      actualDecisionPersonId: mutation,
      decision: {
        kind: 'EXIT',
        resumeCondition: null,
        reviewOn: { state: 'UNKNOWN', value: null },
        exitReason: null,
        reentryCondition: null,
      },
      recordText: 'TEST decision',
      basis: 'TEST authority',
      occurrence: { occurredAt: null, timezone: null, businessDate: null },
      proxy: null,
      sources: [],
    };
    expect(() => parseRecordOpportunityDecision(c)).toThrow();
    expect(() =>
      parseRecordOpportunityDecision({
        ...c,
        decision: {
          ...c.decision,
          kind: 'CONTINUE',
          resumeCondition: 'TEST old',
        },
      }),
    ).toThrow();
  });
});
