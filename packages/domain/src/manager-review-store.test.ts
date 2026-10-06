/** Synthetic TEST admission only; PostgreSQL/HTTP cases live in the integration script. */
import { describe, expect, it } from 'vitest';
import {
  DENY_REVIEW_PORTS,
  reviewReplayAdmission,
} from './manager-review-store.js';
import {
  reviewAuthorityGrant,
  type CompletionDeclaration,
  type ReviewAuthority,
  type ReviewIndependence,
} from './manager-review-rules.js';
import type { Actor } from './store-kit.js';
import type { PoolClient } from 'pg';
const actor: Actor = {
  orgId: 'TEST_org',
  accountId: 'TEST_account',
  personId: 'TEST_reviewer',
  authzVersion: 1,
  decidedAt: '2026-10-06T08:00:00Z',
};
const target = {
  projectId: 'TEST_project',
  crewId: 'TEST_crew',
  businessDate: '2026-10-06',
  itemKey: 'TEST_item',
  foremanRevisionId: 'TEST_revision',
};
const declaration: CompletionDeclaration = {
  orgId: actor.orgId,
  target,
  revisionNumber: 1,
  qty: 'unknown',
  unit: null,
  scopeRef: null,
  scopeStatus: 'PENDING',
  reportedByPersonId: 'TEST_reporter',
  reportedIdentityResolved: true,
  changedByPersonIds: [],
};
const authority: ReviewAuthority = {
  ...actor,
  active: true,
  identityResolved: true,
  policyRef: 'TEST_policy',
  grants: [],
};
const independence: ReviewIndependence = {
  status: 'CLEAR',
  policyRef: 'TEST_independence',
  partiesComplete: true,
  partyPersonIds: [],
};
describe('TEST replay admission is separate from new-write CAS/evidence', () => {
  it('default server ports supply no rights, evidence or declared-scope proof', async () => {
    const client = {} as PoolClient;
    const a = await DENY_REVIEW_PORTS.resolveAuthority(client, actor, target);
    expect(reviewAuthorityGrant(a, actor.orgId, target, 'RETURN')).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(
      await DENY_REVIEW_PORTS.evidenceFor(client, actor, target),
    ).toBeNull();
    expect(
      await DENY_REVIEW_PORTS.sourceContextFor(
        client,
        actor,
        target,
        'TEST_reporter',
      ),
    ).toMatchObject({
      scopeStatus: 'PENDING',
      reportedIdentityResolved: false,
      unit: null,
    });
  });
  it('an unknown declared quantity and absent evidence do not incorrectly prohibit an independent successful replay', () => {
    expect(() =>
      reviewReplayAdmission(actor, authority, declaration, independence),
    ).not.toThrow();
  });
  it.each(['orgId', 'accountId', 'personId'] as const)(
    'server authority cannot substitute another actor %s',
    (field) => {
      expect(() =>
        reviewReplayAdmission(
          actor,
          { ...authority, [field]: 'TEST_forged' },
          declaration,
          independence,
        ),
      ).toThrow('FORBIDDEN');
    },
  );
  it('the same natural person under another account is still self-review', () => {
    expect(() =>
      reviewReplayAdmission(
        { ...actor, accountId: 'TEST_twin' },
        { ...authority, accountId: 'TEST_twin' },
        { ...declaration, reportedByPersonId: actor.personId },
        independence,
      ),
    ).toThrow('SELF_REVIEW');
  });
  it.each([false, true])(
    'source author and reviewer identities must both be resolved (source flag %s)',
    (sourceResolved) => {
      expect(() =>
        reviewReplayAdmission(
          actor,
          { ...authority, identityResolved: !sourceResolved },
          { ...declaration, reportedIdentityResolved: sourceResolved },
          independence,
        ),
      ).toThrow('IDENTITY_UNKNOWN');
    },
  );
  it('proxy authors cannot independently review the transaction', () => {
    expect(() =>
      reviewReplayAdmission(
        actor,
        authority,
        { ...declaration, changedByPersonIds: [actor.personId] },
        independence,
      ),
    ).toThrow('SELF_REVIEW');
  });
  it.each(['CONFLICT', 'UNKNOWN'] as const)(
    'transaction independence %s fails closed',
    (status) => {
      expect(() =>
        reviewReplayAdmission(actor, authority, declaration, {
          ...independence,
          status,
        }),
      ).toThrow(
        status === 'CONFLICT' ? 'REVIEW_CONFLICT' : 'INDEPENDENCE_UNKNOWN',
      );
    },
  );
  it('known related parties cannot become independent by choosing a different account', () => {
    expect(() =>
      reviewReplayAdmission(actor, authority, declaration, {
        ...independence,
        partyPersonIds: [actor.personId],
      }),
    ).toThrow('REVIEW_CONFLICT');
  });
  it.each([{ partiesComplete: false }, { policyRef: null }])(
    'partial independence basis %j cannot replay',
    (change) => {
      expect(() =>
        reviewReplayAdmission(actor, authority, declaration, {
          ...independence,
          ...change,
        }),
      ).toThrow('INDEPENDENCE_UNKNOWN');
    },
  );
});
