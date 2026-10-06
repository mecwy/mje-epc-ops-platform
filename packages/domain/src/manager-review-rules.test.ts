/** Synthetic TEST rules only; HTTP, RLS, idempotent persistence and real UAT are not exercised. */
import { describe, expect, it } from 'vitest';
import {
  parseReviewForemanCommand,
  type CompletionEvidenceDto,
  type CompletionReviewEventDto,
  type CompletionReviewStateDto,
} from '@mje/contracts';
import {
  completionReviewState,
  planCompletionReview,
  reviewAuthorityGrant,
  sameCompletionTarget,
  type CompletionReviewContext,
  type CompletionReviewEvent,
  type CompletionReviewRequest,
  type CompletionReviewPlan,
  type CompletionReviewState,
} from './manager-review-rules.js';
import { foremanDateAllowed } from './report-rules.js';

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const target = {
  projectId: uuid(1),
  businessDate: '2026-10-05',
  crewId: uuid(2),
  foremanRevisionId: uuid(3),
  itemKey: 'TEST_work',
};
const basis = { linkSetId: uuid(4), version: 1 };
const scope = uuid(5);
const part = uuid(6);
const org = uuid(7);
const reporter = uuid(8);
const reviewer = uuid(9);
const request = (): CompletionReviewRequest => ({
  target: { ...target },
  expectedRevision: 1,
  expectedVersion: 0,
  decision: 'CONFIRM_SCOPE',
  coverage: { kind: 'WHOLE' },
  evidenceBasis: { ...basis },
  reason: '',
  method: 'TEST observation',
  limitations: '',
});
const context = (): CompletionReviewContext => ({
  authority: {
    orgId: org,
    accountId: uuid(10),
    personId: reviewer,
    active: true,
    identityResolved: true,
    policyRef: uuid(11),
    decidedAt: '2026-10-06T08:00:00Z',
    grants: [
      {
        id: uuid(12),
        orgId: org,
        projectId: target.projectId,
        crewId: target.crewId,
        itemKey: target.itemKey,
        actions: ['CONFIRM_SCOPE', 'RETURN', 'INCONCLUSIVE', 'READ_REVIEW'],
        validFrom: '2026-10-01T00:00:00Z',
        validUntil: null,
      },
    ],
  },
  declaration: {
    orgId: org,
    target: { ...target },
    revisionNumber: 1,
    qty: '100',
    unit: 'TEST-unit',
    scopeRef: scope,
    scopeStatus: 'CONFIRMED',
    reportedByPersonId: reporter,
    reportedIdentityResolved: true,
    changedByPersonIds: [],
  },
  independence: {
    status: 'CLEAR',
    policyRef: uuid(13),
    partiesComplete: true,
    partyPersonIds: [reporter],
  },
  evidence: {
    orgId: org,
    target: { ...target },
    basis: { ...basis },
    state: 'READY',
    coverage: {
      scopeRef: scope,
      withinScopeRef: scope,
      qty: '100',
      unit: 'TEST-unit',
    },
    photos: [{ photoId: uuid(14), photoVersion: 1, linkId: uuid(15) }],
  },
  reviewVersion: 0,
});

function admitted(r = request(), c = context()): CompletionReviewPlan {
  const result = planCompletionReview(r, c);
  if (!result.ok) throw new Error(`TEST unexpected refusal ${result.code}`);
  return result.value;
}
function event(r = request(), c = context(), n = 16): CompletionReviewEvent {
  return { ...admitted(r, c), id: uuid(n), orgId: org };
}
function state(
  c: CompletionReviewContext,
  events: CompletionReviewEvent[],
): CompletionReviewState {
  const result = completionReviewState(
    c.authority,
    c.declaration,
    c.evidence,
    events,
  );
  if (!result.ok)
    throw new Error(`TEST unexpected projection refusal ${result.code}`);
  return result.value;
}

describe('completion review authority and independence (CG-I01/02, AT67/68)', () => {
  it('accepts an explicitly scoped independent reviewer and copies only a judgment', () => {
    expect(admitted()).toMatchObject({
      version: 1,
      decision: 'CONFIRM_SCOPE',
      confirmedQty: '100',
      scopeRef: scope,
      reviewerPersonId: reviewer,
      authorityGrantId: uuid(12),
    });
    expect(admitted()).not.toHaveProperty('declaredQty');
  });

  it('a job title/canWrite does not replace a grant, even with complete evidence', () => {
    const c = context();
    const authority = {
      ...c.authority,
      grants: [],
      role: 'PROJECT_MANAGER',
      canWrite: true,
    };
    expect(planCompletionReview(request(), { ...c, authority })).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
  });

  it.each([
    'org',
    'project',
    'crew',
    'item',
    'action',
    'inactive',
    'empty',
  ] as const)('refuses a scope/authority mismatch: %s', (kind) => {
    const c = context();
    const g = c.authority.grants[0]!;
    const changes = {
      org: { orgId: uuid(90) },
      project: { projectId: uuid(90) },
      crew: { crewId: uuid(90) },
      item: { itemKey: 'TEST_other' },
      action: { actions: ['READ_REVIEW'] as const },
      inactive: {},
      empty: {},
    };
    const authority = {
      ...c.authority,
      active: kind !== 'inactive',
      grants: kind === 'empty' ? [] : [{ ...g, ...changes[kind] }],
    };
    expect(planCompletionReview(request(), { ...c, authority }).ok).toBe(false);
  });

  it('explicit project-wide crew/item scope still cannot span projects', () => {
    const c = context();
    const authority = {
      ...c.authority,
      grants: [{ ...c.authority.grants[0]!, crewId: null, itemKey: null }],
    };
    expect(planCompletionReview(request(), { ...c, authority }).ok).toBe(true);
    expect(
      reviewAuthorityGrant(
        authority,
        org,
        { ...target, projectId: uuid(90) },
        'CONFIRM_SCOPE',
      ).ok,
    ).toBe(false);
  });

  it.each([
    { validFrom: '2026-10-06T08:00:01Z' },
    { validUntil: '2026-10-06T08:00:00Z' },
    { validUntil: '2026-02-30T00:00:00Z' },
  ])(
    'uses the server decision time and half-open authorization interval: %j',
    (changes) => {
      const c = context();
      const authority = {
        ...c.authority,
        grants: [{ ...c.authority.grants[0]!, ...changes }],
      };
      expect(planCompletionReview(request(), { ...c, authority }).ok).toBe(
        false,
      );
    },
  );

  it('requires a policy basis and resolved identities, not just different account IDs', () => {
    const c = context();
    for (const authority of [
      { ...c.authority, policyRef: null },
      { ...c.authority, identityResolved: false },
      { ...c.authority, personId: null },
      { ...c.authority, decidedAt: 'TEST invalid time' },
    ])
      expect(planCompletionReview(request(), { ...c, authority }).ok).toBe(
        false,
      );
    expect(
      planCompletionReview(request(), {
        ...c,
        declaration: { ...c.declaration, reportedByPersonId: null },
      }).ok,
    ).toBe(false);
  });

  it('same natural person through another account cannot review its own declaration', () => {
    const c = context();
    const authority = {
      ...c.authority,
      accountId: uuid(91),
      personId: reporter,
    };
    expect(planCompletionReview(request(), { ...c, authority })).toEqual({
      ok: false,
      code: 'SELF_REVIEW',
    });
    expect(
      planCompletionReview(
        {
          ...request(),
          decision: 'RETURN',
          coverage: null,
          evidenceBasis: null,
          reason: 'TEST correction',
        },
        { ...c, authority },
      ).ok,
    ).toBe(false);
  });

  it('does not confuse an existing provisional source Person ID with a resolved claimant', () => {
    const c = context();
    const declaration = { ...c.declaration, reportedIdentityResolved: false };
    expect(planCompletionReview(request(), { ...c, declaration })).toEqual({
      ok: false,
      code: 'IDENTITY_UNKNOWN',
    });
  });

  it('actual proxy/edit authors and known transaction interests cannot self-review', () => {
    const c = context();
    expect(
      planCompletionReview(request(), {
        ...c,
        declaration: { ...c.declaration, changedByPersonIds: [reviewer] },
      }),
    ).toEqual({ ok: false, code: 'SELF_REVIEW' });
    expect(
      planCompletionReview(request(), {
        ...c,
        independence: {
          ...c.independence,
          partyPersonIds: [reporter, reviewer],
        },
      }),
    ).toEqual({ ok: false, code: 'REVIEW_CONFLICT' });
  });

  it.each([
    { status: 'UNKNOWN' as const },
    { status: 'CONFLICT' as const },
    { partiesComplete: false },
    { policyRef: null },
  ])(
    'missing/contradicted transaction independence stays unconfirmed: %j',
    (changes) => {
      const c = context();
      expect(
        planCompletionReview(request(), {
          ...c,
          independence: { ...c.independence, ...changes },
        }).ok,
      ).toBe(false);
    },
  );

  it('authorization runs before reading even an empty review history', () => {
    const c = context();
    for (const authority of [
      { ...c.authority, active: false },
      { ...c.authority, orgId: uuid(90) },
      { ...c.authority, grants: [] },
    ])
      expect(
        completionReviewState(authority, c.declaration, c.evidence, []),
      ).toEqual({ ok: false, code: 'FORBIDDEN' });
  });
});

describe('completion target/evidence cut and coverage (CG-I05, PC13)', () => {
  it.each([
    'projectId',
    'businessDate',
    'crewId',
    'foremanRevisionId',
    'itemKey',
  ] as const)('does not silently rebind the target %s', (key) => {
    const c = context();
    const value =
      key === 'businessDate'
        ? '2026-10-04'
        : key === 'itemKey'
          ? 'TEST_other'
          : uuid(90);
    expect(sameCompletionTarget(target, { ...target, [key]: value })).toBe(
      false,
    );
    expect(
      planCompletionReview(request(), {
        ...c,
        declaration: { ...c.declaration, target: { ...target, [key]: value } },
      }),
    ).toEqual({ ok: false, code: 'TARGET_CHANGED' });
  });

  it('refuses an obsolete crew revision or competing review event sequence', () => {
    const c = context();
    expect(
      planCompletionReview(request(), {
        ...c,
        declaration: { ...c.declaration, revisionNumber: 2 },
      }),
    ).toEqual({ ok: false, code: 'FOREMAN_REVISION_CHANGED' });
    expect(planCompletionReview(request(), { ...c, reviewVersion: 1 })).toEqual(
      { ok: false, code: 'REVIEW_VERSION_CONFLICT' },
    );
  });

  it('rejects invalid internal review/revision counters instead of appending version zero', () => {
    const c = context();
    expect(
      planCompletionReview(
        { ...request(), expectedVersion: -1 },
        { ...c, reviewVersion: -1 },
      ),
    ).toEqual({ ok: false, code: 'REVIEW_VERSION_CONFLICT' });
    expect(
      planCompletionReview(
        { ...request(), expectedRevision: 0 },
        { ...c, declaration: { ...c.declaration, revisionNumber: 0 } },
      ),
    ).toEqual({ ok: false, code: 'FOREMAN_REVISION_CHANGED' });
  });

  it.each(['org', 'target', 'set', 'version'] as const)(
    'refuses a changed/cross-boundary evidence %s',
    (key) => {
      const c = context();
      const e = c.evidence!;
      const changes = {
        org: { orgId: uuid(90) },
        target: { target: { ...target, foremanRevisionId: uuid(90) } },
        set: { basis: { ...basis, linkSetId: uuid(90) } },
        version: { basis: { ...basis, version: 2 } },
      };
      expect(
        planCompletionReview(request(), {
          ...c,
          evidence: { ...e, ...changes[key] },
        }),
      ).toEqual({ ok: false, code: 'EVIDENCE_CHANGED' });
    },
  );

  it('missing C05/photo associations cannot confirm; they can be returned with reasons', () => {
    const c = context();
    expect(planCompletionReview(request(), { ...c, evidence: null }).ok).toBe(
      false,
    );
    for (const evidence of [
      { ...c.evidence!, state: 'MISSING' as const },
      { ...c.evidence!, state: 'UNCONFIRMED_SCOPE' as const },
      { ...c.evidence!, photos: [] },
      { ...c.evidence!, coverage: null },
    ])
      expect(planCompletionReview(request(), { ...c, evidence })).toEqual({
        ok: false,
        code: 'EVIDENCE_REQUIRED',
      });
    expect(
      admitted(
        {
          ...request(),
          decision: 'RETURN',
          coverage: null,
          evidenceBasis: null,
          reason: 'TEST missing association',
          method: '',
        },
        { ...c, evidence: null },
      ),
    ).toMatchObject({
      decision: 'RETURN',
      confirmedQty: null,
      scopeRef: null,
      unit: null,
    });
  });

  it.each([
    { photoId: '', photoVersion: 1, linkId: uuid(15) },
    { photoId: uuid(14), photoVersion: 0, linkId: uuid(15) },
    { photoId: uuid(14), photoVersion: 1, linkId: '' },
  ])(
    'does not accept an unversioned or unlinked photo placeholder: %j',
    (photo) => {
      const c = context();
      expect(
        planCompletionReview(request(), {
          ...c,
          evidence: { ...c.evidence!, photos: [photo] },
        }),
      ).toEqual({ ok: false, code: 'EVIDENCE_REQUIRED' });
    },
  );

  it('unknown area and a same-name photo from another scope cannot be confirmed', () => {
    const c = context();
    expect(
      planCompletionReview(request(), {
        ...c,
        declaration: { ...c.declaration, scopeStatus: 'PENDING' },
      }),
    ).toEqual({ ok: false, code: 'SCOPE_UNCONFIRMED' });
    expect(
      planCompletionReview(request(), {
        ...c,
        evidence: {
          ...c.evidence!,
          coverage: { ...c.evidence!.coverage!, withinScopeRef: uuid(90) },
        },
      }),
    ).toEqual({ ok: false, code: 'SCOPE_UNCONFIRMED' });
    expect(
      planCompletionReview(request(), {
        ...c,
        evidence: {
          ...c.evidence!,
          coverage: { ...c.evidence!.coverage!, scopeRef: part },
        },
      }).ok,
    ).toBe(false);
  });

  it.each(['', 'unknown', 'na'])(
    'does not turn source %s into a confirmed zero',
    (qty) => {
      const c = context();
      expect(
        planCompletionReview(request(), {
          ...c,
          declaration: { ...c.declaration, qty },
        }),
      ).toEqual({ ok: false, code: 'QUANTITY_UNKNOWN' });
    },
  );

  it('a confirmed explicit zero retains whole scope without a percentage denominator', () => {
    const c = context();
    const zero = {
      ...c,
      declaration: { ...c.declaration, qty: '0' },
      evidence: {
        ...c.evidence!,
        coverage: { ...c.evidence!.coverage!, qty: '0' },
      },
    };
    const e = event(request(), zero);
    expect(e.confirmedQty).toBe('0');
    expect(state(zero, [e])).toMatchObject({
      status: 'CONFIRMED_SCOPE',
      confirmedQty: '0',
      coverage: 'FULL',
    });
    expect(state(zero, [e])).not.toHaveProperty('percentage');
  });

  it('partially checks 40 of 100 and cannot extrapolate to the whole declaration', () => {
    const c = context();
    const partial = {
      ...c,
      evidence: {
        ...c.evidence!,
        state: 'PARTIAL' as const,
        coverage: { ...c.evidence!.coverage!, scopeRef: part, qty: '40' },
      },
    };
    const r = {
      ...request(),
      coverage: { kind: 'PARTIAL' as const, scopeRef: part, qty: '40' },
    };
    expect(state(partial, [event(r, partial)])).toMatchObject({
      coverage: 'PARTIAL',
      confirmedQty: '40',
    });
    expect(planCompletionReview(request(), partial).ok).toBe(false);
    expect(
      planCompletionReview(
        { ...r, coverage: { ...r.coverage, qty: '41' } },
        partial,
      ).ok,
    ).toBe(false);
    expect(
      planCompletionReview({ ...r, coverage: { ...r.coverage, qty: '100' } }, c)
        .ok,
    ).toBe(false);
  });

  it('does not infer a quantity conversion from labels or accept missing units', () => {
    const c = context();
    expect(
      planCompletionReview(request(), {
        ...c,
        declaration: { ...c.declaration, unit: null },
      }),
    ).toEqual({ ok: false, code: 'UNIT_MISMATCH' });
    expect(
      planCompletionReview(request(), {
        ...c,
        evidence: {
          ...c.evidence!,
          coverage: { ...c.evidence!.coverage!, unit: 'TEST-other-unit' },
        },
      }),
    ).toEqual({ ok: false, code: 'UNIT_MISMATCH' });
  });

  it('uses existing exact decimal arithmetic at the precision/range boundary', () => {
    const c = context();
    const qty = '99999999999999.999999';
    const precise = {
      ...c,
      declaration: { ...c.declaration, qty },
      evidence: { ...c.evidence!, coverage: { ...c.evidence!.coverage!, qty } },
    };
    expect(admitted(request(), precise).confirmedQty).toBe(qty);
    expect(
      planCompletionReview(request(), {
        ...precise,
        declaration: { ...precise.declaration, qty: '100000000000000' },
      }).ok,
    ).toBe(false);
  });

  it('return/inconclusive cannot carry or clear facts through a confirmation quantity', () => {
    const c = context();
    expect(
      planCompletionReview(
        {
          ...request(),
          decision: 'RETURN',
          coverage: null,
          evidenceBasis: null,
          reason: ' ',
        },
        c,
      ),
    ).toEqual({ ok: false, code: 'REASON_REQUIRED' });
    expect(
      planCompletionReview(
        {
          ...request(),
          decision: 'INCONCLUSIVE',
          coverage: { kind: 'WHOLE' },
          reason: 'TEST unknown',
        },
        c,
      ),
    ).toEqual({ ok: false, code: 'COVERAGE_INVALID' });
    expect(
      admitted({
        ...request(),
        decision: 'INCONCLUSIVE',
        coverage: null,
        reason: 'TEST pending',
      }),
    ).toMatchObject({ confirmedQty: null, unit: null });
  });
});

describe('current and historical judgments (CG-I03/04/05)', () => {
  it('empty authorized history is not checked, never implicitly confirmed', () => {
    expect(state(context(), [])).toMatchObject({
      status: 'NOT_CHECKED',
      coverage: 'NONE',
      confirmedQty: null,
    });
  });

  it('r2 cannot inherit the confirmation of r1 and historical objects remain unchanged', () => {
    const c = context();
    const e = event();
    const before = structuredClone({ c, e });
    const r2 = {
      ...c,
      declaration: {
        ...c.declaration,
        revisionNumber: 2,
        target: { ...target, foremanRevisionId: uuid(90) },
        qty: '80',
      },
    };
    expect(state(r2, [e])).toMatchObject({
      status: 'REVIEW_REQUIRED',
      confirmedQty: null,
      reviewVersion: 0,
    });
    expect(state(c, [e])).toMatchObject({
      status: 'CONFIRMED_SCOPE',
      confirmedQty: '100',
    });
    expect({ c, e }).toEqual(before);
  });

  it('changed/removed photo associations require new review of current scope', () => {
    const c = context();
    const e = event();
    for (const evidence of [
      null,
      { ...c.evidence!, basis: { ...basis, version: 2 } },
      { ...c.evidence!, photos: [] },
      {
        ...c.evidence!,
        photos: [{ photoId: uuid(14), photoVersion: 0, linkId: uuid(15) }],
      },
    ])
      expect(state({ ...c, evidence }, [e])).toMatchObject({
        status: 'REVIEW_REQUIRED',
        confirmedQty: null,
      });
  });

  it('latest judgment replaces coverage; copies are not additional quantities', () => {
    const c = context();
    const partial = {
      ...c,
      evidence: {
        ...c.evidence!,
        state: 'PARTIAL' as const,
        coverage: { ...c.evidence!.coverage!, scopeRef: part, qty: '40' },
      },
    };
    const r = {
      ...request(),
      coverage: { kind: 'PARTIAL' as const, scopeRef: part, qty: '40' },
    };
    const first = event(r, partial);
    const second = event(
      { ...r, expectedVersion: 1, coverage: { ...r.coverage, qty: '30' } },
      { ...partial, reviewVersion: 1 },
      17,
    );
    expect(state(partial, [second, first, { ...second }])).toMatchObject({
      confirmedQty: '30',
      reviewVersion: 2,
    });
    expect(state(partial, [first, first]).confirmedQty).toBe('40');
  });

  it('ignores another tenant/project/crew/item rather than using it as coverage', () => {
    const c = context();
    const e = event();
    for (const foreign of [
      { ...e, orgId: uuid(90) },
      { ...e, target: { ...target, projectId: uuid(90) } },
      { ...e, target: { ...target, crewId: uuid(90) } },
      { ...e, target: { ...target, itemKey: 'TEST_other' } },
    ])
      expect(state(c, [foreign]).status).toBe('NOT_CHECKED');
  });

  it('conflicting events at one sequence cannot be resolved by array or wall-clock order', () => {
    const c = context();
    const e = event();
    expect(
      completionReviewState(c.authority, c.declaration, c.evidence, [
        e,
        { ...e, id: uuid(90) },
      ]),
    ).toEqual({ ok: false, code: 'REVIEW_HISTORY_CONFLICT' });
  });

  it('the same event identity with different contents is a conflict, not a harmless replay', () => {
    const c = context();
    const e = event();
    expect(
      completionReviewState(c.authority, c.declaration, c.evidence, [
        e,
        { ...e, confirmedQty: '40' },
      ]),
    ).toEqual({ ok: false, code: 'REVIEW_HISTORY_CONFLICT' });
  });

  it.each([0, -1, 1.5, 1_000_001])(
    'invalid stored event sequence %s cannot produce confirmation',
    (version) => {
      const c = context();
      expect(
        completionReviewState(c.authority, c.declaration, c.evidence, [
          { ...event(), version },
        ]),
      ).toEqual({ ok: false, code: 'REVIEW_HISTORY_CONFLICT' });
    },
  );

  it('a later judgment does not hide a conflicting earlier stored event', () => {
    const c = context();
    const first = event();
    const second = event(
      { ...request(), expectedVersion: 1 },
      { ...c, reviewVersion: 1 },
      17,
    );
    expect(
      completionReviewState(c.authority, c.declaration, c.evidence, [
        first,
        { ...first, method: 'TEST altered' },
        second,
      ]),
    ).toEqual({ ok: false, code: 'REVIEW_HISTORY_CONFLICT' });
  });

  it('a subsequent return/inconclusive preserves original values and reports no verified quantity', () => {
    const c = context();
    for (const decision of ['RETURN', 'INCONCLUSIVE'] as const) {
      const r = {
        ...request(),
        decision,
        coverage: null,
        evidenceBasis: null,
        reason: 'TEST recheck',
        expectedVersion: 1,
      };
      const second = event(r, { ...c, reviewVersion: 1 }, 17);
      expect(state(c, [event(), second])).toMatchObject({
        status: decision === 'RETURN' ? 'RETURNED' : 'INCONCLUSIVE',
        confirmedQty: null,
      });
      expect(c.declaration.qty).toBe('100');
    }
  });

  it('the boundary and domain ports agree without modifying shared exports', () => {
    const parsed = parseReviewForemanCommand({
      ...request(),
      schemaVersion: 1,
      clientMutationId: uuid(20),
    });
    const c = context();
    const planned = admitted(parsed, c);
    const dto: CompletionEvidenceDto = c.evidence!;
    const eventDto: CompletionReviewEventDto = { ...planned, id: uuid(16) };
    const stateDto: CompletionReviewStateDto = state(c, [event(parsed, c)]);
    expect(dto.target).toEqual(eventDto.target);
    expect(stateDto.status).toBe('CONFIRMED_SCOPE');
    expect(stateDto).not.toHaveProperty('qualityAccepted');
    expect(stateDto).not.toHaveProperty('chargeableQty');
  });

  it('does not expand the existing ordinary foreman date guard (D2 unresolved)', () => {
    expect(foremanDateAllowed('2026-10-05', '2026-10-06')).toBe('ok');
    expect(foremanDateAllowed('2026-10-04', '2026-10-06')).toBe('tooOld');
  });
});
