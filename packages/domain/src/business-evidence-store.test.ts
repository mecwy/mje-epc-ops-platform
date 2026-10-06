import { describe, it, expect } from 'vitest';
import {
  authorityAllows,
  deniedBusinessEvidencePorts,
  mediaMatches,
} from './business-evidence-store.js';
import {
  projectCurrentEvidence,
  BusinessEvidenceReader,
} from './business-evidence-reader.js';
import type { EvidenceVersion } from './business-evidence-reader.js';
import type { CompletionDeclaration } from './manager-review-rules.js';
import type { Actor } from './store-kit.js';
import type { PoolClient } from 'pg';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const target = {
  projectId: id(2),
  businessDate: '2026-10-06',
  crewId: id(3),
  foremanRevisionId: id(4),
  itemKey: 'TEST_WORK',
};
const actor: Actor = {
  orgId: id(1),
  accountId: id(5),
  personId: id(6),
  authzVersion: 1,
  decidedAt: '2026-10-06T12:00:00Z',
};
const declaration: CompletionDeclaration = {
  orgId: actor.orgId,
  target,
  revisionNumber: 1,
  qty: '10.000000',
  unit: 'm',
  scopeRef: id(7),
  scopeStatus: 'CONFIRMED',
  reportedByPersonId: actor.personId,
  reportedIdentityResolved: true,
  changedByPersonIds: [actor.personId],
};
const ref = { photoId: id(8), photoVersion: 1 };
const photo = {
  ...ref,
  orgId: actor.orgId,
  projectId: target.projectId,
  businessDate: target.businessDate,
  available: true,
  authorized: true,
};
const scopes = [
  { scopeRef: id(7), withinScopeRef: id(7), label: 'TEST whole' },
  { scopeRef: id(9), withinScopeRef: id(7), label: 'TEST partial' },
];
const version: EvidenceVersion = {
  id: id(10),
  daySeq: 1,
  associationCoverage: {
    scopeRef: id(7),
    withinScopeRef: id(7),
    qty: '10',
    unit: 'm',
  },
  evidence: {
    target,
    basis: { linkSetId: id(11), version: 1 },
    state: 'READY',
    coverage: { scopeRef: id(7), withinScopeRef: id(7), qty: '10', unit: 'm' },
    photos: [{ ...ref, linkId: id(12) }],
  },
};
describe('C05 authority/media/read boundaries', () => {
  it('defaults all production ports to deny/unknown', async () => {
    const client = {} as PoolClient;
    expect(
      await deniedBusinessEvidencePorts.resolveAuthority(client, actor, target),
    ).toBeNull();
    expect(
      await deniedBusinessEvidencePorts.resolveDeclaration(
        client,
        actor,
        target,
      ),
    ).toBeNull();
    expect(
      await deniedBusinessEvidencePorts.readMedia(
        client,
        actor,
        target,
        ref,
        'READ',
      ),
    ).toBeNull();
    await expect(
      deniedBusinessEvidencePorts.withDayGate(client, actor, target, () =>
        Promise.resolve(null),
      ),
    ).rejects.toThrow('INTEGRATION_REQUIRED');
  });
  it('rejects a client outside a live verified account transaction before any query', async () => {
    const client = {} as PoolClient;
    await expect(
      BusinessEvidenceReader.read(client, actor, target, {
        ...deniedBusinessEvidencePorts,
        resolveReadCut: () =>
          Promise.resolve({ kind: 'CURRENT', writable: false }),
        listMedia: () => Promise.resolve([]),
      }),
    ).rejects.toThrow('INTEGRATION_REQUIRED');
  });
  it('requires exact tenant/project/crew/item policy and explicit operation', () => {
    const authority = {
      orgId: actor.orgId,
      projectId: target.projectId,
      crewId: target.crewId,
      itemKey: target.itemKey,
      policyRef: 'TEST_ONLY',
      allowed: ['BIND'] as const,
    };
    expect(authorityAllows(authority, actor, target, 'BIND')).toBe(true);
    expect(authorityAllows(authority, actor, target, 'UNBIND')).toBe(false);
    for (const bad of [
      { ...authority, orgId: id(99) },
      { ...authority, crewId: id(99) },
      { ...authority, policyRef: '' },
    ])
      expect(authorityAllows(bad, actor, target, 'BIND')).toBe(false);
  });
  it.each([
    'orgId',
    'projectId',
    'businessDate',
    'photoId',
    'photoVersion',
    'authorized',
  ] as const)('checks media field %s before receipt access', (field) => {
    const bad = {
      ...photo,
      [field]:
        field === 'authorized' ? false : field === 'photoVersion' ? 2 : id(99),
    };
    expect(mediaMatches(bad, actor, target, ref)).toBe(false);
  });
  it('rechecks disappearance without changing the recorded version or source', () => {
    expect(
      projectCurrentEvidence(version, declaration, scopes, [
        { ...photo, available: false },
      ]).state,
    ).toBe('MISSING');
    expect(version.evidence.state).toBe('READY');
    expect(declaration.qty).toBe('10.000000');
  });
  it('requires explicit containment and exact decimal quantity', () => {
    expect(
      projectCurrentEvidence(version, declaration, scopes, [photo]).state,
    ).toBe('READY');
    expect(
      projectCurrentEvidence(version, declaration, [], [photo]).state,
    ).toBe('UNCONFIRMED_SCOPE');
    const partial = {
      ...version,
      evidence: {
        ...version.evidence,
        coverage: { ...version.evidence.coverage!, scopeRef: id(9) },
      },
    };
    expect(
      projectCurrentEvidence(partial, declaration, scopes, [photo]).state,
    ).toBe('PARTIAL');
    const excess = {
      ...version,
      evidence: {
        ...version.evidence,
        coverage: { ...version.evidence.coverage!, qty: '10.000001' },
      },
    };
    expect(
      projectCurrentEvidence(excess, declaration, scopes, [photo]).state,
    ).toBe('UNCONFIRMED_SCOPE');
  });
  it.each(['', 'unknown', 'na'])('keeps source %s unknown', (qty) =>
    expect(
      projectCurrentEvidence(version, { ...declaration, qty }, scopes, [photo])
        .state,
    ).toBe('UNCONFIRMED_SCOPE'),
  );
  it('does not turn incomplete coverage into zero or whole coverage', () => {
    expect(
      projectCurrentEvidence(
        { ...version, evidence: { ...version.evidence, coverage: null } },
        declaration,
        scopes,
        [photo],
      ).state,
    ).toBe('PARTIAL');
    expect(
      projectCurrentEvidence(
        version,
        { ...declaration, scopeStatus: 'PENDING' },
        scopes,
        [photo],
      ).state,
    ).toBe('UNCONFIRMED_SCOPE');
  });
});
