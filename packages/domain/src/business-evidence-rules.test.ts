import { describe, expect, it } from 'vitest';
import {
  evidenceNeedsReview,
  planEvidenceBinding,
  type BindingContext,
  type BindingRequest,
} from './business-evidence-rules.js';

// TEST context models trusted transaction reads, never real people or photos.
const target = {
  projectId: 'TEST-project',
  businessDate: '2026-10-06',
  crewId: 'TEST-crew',
  foremanRevisionId: 'TEST-revision',
  itemKey: 'TEST-item',
};
const context = (): BindingContext => ({
  declaration: {
    orgId: 'TEST-org',
    target,
    revisionNumber: 2,
    qty: '10.000001',
    unit: 'TEST-m',
    scopeRef: 'TEST-whole',
    scopeStatus: 'CONFIRMED',
    reportedByPersonId: null,
    reportedIdentityResolved: false,
    changedByPersonIds: [],
  },
  authority: {
    orgId: 'TEST-org',
    projectId: target.projectId,
    crewId: target.crewId,
    itemKey: target.itemKey,
    policyRef: 'TEST-binding-policy',
    allowed: ['BIND', 'UNBIND'],
  },
  current: null,
  currentCoverage: null,
  currentPhotos: [],
  photo: {
    orgId: 'TEST-org',
    projectId: target.projectId,
    businessDate: target.businessDate,
    photoId: 'TEST-photo',
    photoVersion: 3,
    authorized: true,
    available: true,
  },
  scopes: [
    { scopeRef: 'TEST-whole', withinScopeRef: 'TEST-whole' },
    { scopeRef: 'TEST-part', withinScopeRef: 'TEST-whole' },
  ],
  newLinkSetId: 'TEST-set',
  newLinkId: 'TEST-link',
});
const request = (): BindingRequest => ({
  target,
  expectedRevision: 2,
  expectedBasis: null,
  operation: 'BIND',
  photo: { photoId: 'TEST-photo', photoVersion: 3 },
  coverage: {
    scopeRef: 'TEST-whole',
    withinScopeRef: 'TEST-whole',
    qty: '10.000001',
    unit: 'TEST-m',
  },
});
const bound = () => {
  const c = context();
  const result = planEvidenceBinding(request(), c);
  if (!result.ok) throw new Error('TEST fixture failed');
  c.current = result.evidence;
  c.currentCoverage = result.associationCoverage;
  c.currentPhotos = [c.photo!];
  return c;
};

describe('C05 association admission and immutable evidence basis', () => {
  it('appends a whole-scope available set without changing the source or asserting review', () => {
    const c = context(),
      before = structuredClone(c);
    const result = planEvidenceBinding(request(), c);
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      previousBasis: null,
      evidence: {
        state: 'READY',
        basis: { linkSetId: 'TEST-set', version: 1 },
      },
    });
    expect(c).toEqual(before);
    expect(result).not.toHaveProperty('review');
    expect(result).not.toHaveProperty('verifiedQty');
  });
  it.each(['orgId', 'projectId', 'crewId', 'itemKey'] as const)(
    'rejects a mismatched server grant %s',
    (field) => {
      const c = context();
      c.authority = { ...c.authority!, [field]: 'TEST-other' };
      expect(planEvidenceBinding(request(), c)).toEqual({
        ok: false,
        code: 'FORBIDDEN',
      });
    },
  );
  it('never treats ordinary write permission or no policy as a binding grant', () => {
    for (const authority of [
      null,
      { ...context().authority!, allowed: [] },
      { ...context().authority!, policyRef: '' },
    ]) {
      expect(
        planEvidenceBinding(request(), { ...context(), authority }),
      ).toEqual({ ok: false, code: 'FORBIDDEN' });
    }
  });
  it.each([
    'projectId',
    'businessDate',
    'crewId',
    'foremanRevisionId',
    'itemKey',
  ] as const)('keeps the exact target tuple: %s', (field) => {
    const r = { ...request(), target: { ...target, [field]: 'TEST-other' } };
    const c = context();
    c.authority = {
      ...c.authority!,
      projectId: r.target.projectId,
      crewId: r.target.crewId,
      itemKey: r.target.itemKey,
    };
    expect(planEvidenceBinding(r, c)).toEqual({
      ok: false,
      code: 'TARGET_CHANGED',
    });
  });
  it('rejects a stale revision or set, including a null-set overwrite', () => {
    expect(
      planEvidenceBinding({ ...request(), expectedRevision: 1 }, context()),
    ).toEqual({ ok: false, code: 'REVISION_CONFLICT' });
    expect(planEvidenceBinding(request(), bound())).toEqual({
      ok: false,
      code: 'EVIDENCE_CHANGED',
    });
    expect(
      planEvidenceBinding(
        {
          ...request(),
          expectedBasis: { linkSetId: 'TEST-other', version: 1 },
        },
        bound(),
      ),
    ).toEqual({ ok: false, code: 'EVIDENCE_CHANGED' });
    expect(
      planEvidenceBinding(
        { ...request(), expectedBasis: { linkSetId: 'TEST-set', version: 2 } },
        bound(),
      ),
    ).toEqual({ ok: false, code: 'EVIDENCE_CHANGED' });
    expect(
      planEvidenceBinding(
        { ...request(), expectedBasis: { linkSetId: 'TEST-set', version: 1 } },
        context(),
      ),
    ).toEqual({ ok: false, code: 'EVIDENCE_CHANGED' });
  });
  it.each([
    { authorized: false },
    { available: false },
    { orgId: 'TEST-other' },
    { projectId: 'TEST-other' },
    { businessDate: '2026-10-05' },
    { photoVersion: 2 },
    { photoId: 'TEST-other' },
  ])('rejects unusable, inaccessible or mismatched media %#', (delta) => {
    const c = context();
    c.photo = { ...c.photo!, ...delta };
    expect(planEvidenceBinding(request(), c)).toEqual({
      ok: false,
      code: 'PHOTO_NOT_AVAILABLE',
    });
  });
  it('allows missing coverage to remain partial and leaves blank/unknown/NA source facts intact', () => {
    for (const qty of ['', 'unknown', 'na', '0']) {
      const c = context();
      c.declaration = { ...c.declaration, qty };
      const r = request();
      if (r.operation !== 'BIND') throw new Error('TEST');
      r.coverage = {
        scopeRef: null,
        withinScopeRef: null,
        qty: null,
        unit: null,
      };
      expect(planEvidenceBinding(r, c)).toMatchObject({
        ok: true,
        evidence: { state: 'PARTIAL', coverage: null },
      });
      expect(c.declaration.qty).toBe(qty);
    }
  });
  it('distinguishes explicit zero from a missing coverage quantity', () => {
    const c = context();
    c.declaration = { ...c.declaration, qty: '0' };
    const r = request();
    if (r.operation !== 'BIND') throw new Error('TEST');
    r.coverage.qty = '0';
    expect(planEvidenceBinding(r, c)).toMatchObject({
      ok: true,
      evidence: { state: 'READY', coverage: { qty: '0' } },
    });
  });
  it('keeps an equal quantity on a contained sub-scope partial', () => {
    const r = request();
    if (r.operation !== 'BIND') throw new Error('TEST');
    r.coverage.scopeRef = 'TEST-part';
    expect(planEvidenceBinding(r, context())).toMatchObject({
      ok: true,
      evidence: { state: 'PARTIAL' },
    });
  });
  it('requires explicit containment and exact unit, and compares six-decimal quantities exactly', () => {
    const r = request();
    if (r.operation !== 'BIND') throw new Error('TEST');
    expect(
      planEvidenceBinding(
        { ...r, coverage: { ...r.coverage, withinScopeRef: 'TEST-other' } },
        context(),
      ),
    ).toMatchObject({ ok: false, code: 'SCOPE_UNCONFIRMED' });
    expect(planEvidenceBinding(r, { ...context(), scopes: [] })).toMatchObject({
      ok: false,
      code: 'SCOPE_UNCONFIRMED',
    });
    expect(
      planEvidenceBinding(
        { ...r, coverage: { ...r.coverage, unit: 'TEST-other-unit' } },
        context(),
      ),
    ).toMatchObject({ ok: false, code: 'UNIT_MISMATCH' });
    expect(
      planEvidenceBinding(
        { ...r, coverage: { ...r.coverage, qty: '10.000002' } },
        context(),
      ),
    ).toMatchObject({ ok: false, code: 'COVERAGE_INVALID' });
    expect(
      planEvidenceBinding(
        { ...r, coverage: { ...r.coverage, qty: '10.000000' } },
        context(),
      ),
    ).toMatchObject({ ok: true, evidence: { state: 'PARTIAL' } });
    expect(
      planEvidenceBinding(r, {
        ...context(),
        declaration: { ...context().declaration, qty: 'unknown' },
      }),
    ).toMatchObject({ ok: false, code: 'QUANTITY_UNKNOWN' });
  });
  it('never upgrades an unconfirmed declared scope', () => {
    const c = context();
    c.declaration = { ...c.declaration, scopeStatus: 'PENDING' };
    expect(planEvidenceBinding(request(), c)).toMatchObject({
      ok: true,
      evidence: { state: 'UNCONFIRMED_SCOPE' },
    });
  });
  it('deduplicates the same media version without creating another fact or basis version', () => {
    const c = bound(),
      before = structuredClone(c.current);
    const result = planEvidenceBinding(
      { ...request(), expectedBasis: c.current!.basis },
      c,
    );
    expect(result).toMatchObject({
      ok: true,
      changed: false,
      evidence: { basis: { version: 1 } },
    });
    if (!result.ok) throw new Error('TEST');
    expect(result.evidence).not.toBe(c.current);
    expect(c.current).toEqual(before);
  });
  it('does not overwrite the scalar coverage of an existing multi-photo set', () => {
    const c = bound();
    c.photo = { ...c.photo!, photoId: 'TEST-photo-2' };
    c.newLinkId = 'TEST-link-2';
    const r = request();
    if (r.operation !== 'BIND') throw new Error('TEST');
    r.expectedBasis = c.current!.basis;
    r.photo.photoId = 'TEST-photo-2';
    r.coverage.qty = '4';
    expect(planEvidenceBinding(r, c)).toEqual({
      ok: false,
      code: 'COVERAGE_CONFLICT',
    });
  });
  it('appends removal, invalidates only the pinned current review, and preserves the old receipt', () => {
    const c = bound(),
      receipt = structuredClone(c.current!);
    const result = planEvidenceBinding(
      {
        target,
        expectedRevision: 2,
        expectedBasis: receipt.basis,
        operation: 'UNBIND',
        linkId: 'TEST-link',
      },
      c,
    );
    expect(result).toMatchObject({
      ok: true,
      previousBasis: receipt.basis,
      evidence: {
        state: 'MISSING',
        basis: { linkSetId: 'TEST-set', version: 2 },
        photos: [],
      },
    });
    if (!result.ok) throw new Error('TEST');
    const reviewed = { target, basis: receipt.basis };
    expect(evidenceNeedsReview(result.evidence, reviewed)).toBe(true);
    expect(evidenceNeedsReview(receipt, reviewed)).toBe(false);
    expect(evidenceNeedsReview(result.evidence, null)).toBe(false);
    expect(c.current).toEqual(receipt);
  });
  it('refuses unknown links and cross-tenant current sets', () => {
    const c = bound();
    expect(
      planEvidenceBinding(
        {
          target,
          expectedRevision: 2,
          expectedBasis: c.current!.basis,
          operation: 'UNBIND',
          linkId: 'TEST-missing',
        },
        c,
      ),
    ).toMatchObject({ ok: false, code: 'LINK_NOT_FOUND' });
    c.current = { ...c.current!, orgId: 'TEST-other' };
    expect(
      planEvidenceBinding({ ...request(), expectedBasis: c.current.basis }, c),
    ).toMatchObject({ ok: false, code: 'TARGET_CHANGED' });
  });
  it('preserves incomplete association fields without fabricating a C04 quantity projection', () => {
    const c = context(),
      r = request();
    if (r.operation !== 'BIND') throw new Error('TEST');
    r.coverage = {
      scopeRef: 'TEST-part',
      withinScopeRef: 'TEST-whole',
      qty: null,
      unit: 'TEST-m',
    };
    const result = planEvidenceBinding(r, c);
    expect(result).toMatchObject({
      ok: true,
      associationCoverage: r.coverage,
      evidence: { state: 'PARTIAL', coverage: null },
    });
    if (!result.ok) throw new Error('TEST');
    c.current = result.evidence;
    c.currentCoverage = result.associationCoverage;
    r.expectedBasis = result.evidence.basis;
    r.coverage.scopeRef = 'TEST-whole';
    expect(planEvidenceBinding(r, c)).toEqual({
      ok: false,
      code: 'COVERAGE_CONFLICT',
    });
  });
  it('cannot reuse the former READY status when a retained media reference is no longer available', () => {
    const c = bound();
    c.currentPhotos = [{ ...c.photo!, available: false }];
    c.photo = { ...c.photo!, photoId: 'TEST-photo-2' };
    c.newLinkId = 'TEST-link-2';
    const r = request();
    if (r.operation !== 'BIND') throw new Error('TEST');
    r.expectedBasis = c.current!.basis;
    r.photo.photoId = 'TEST-photo-2';
    expect(planEvidenceBinding(r, c)).toMatchObject({
      ok: true,
      evidence: {
        state: 'MISSING',
        photos: [{ photoId: 'TEST-photo' }, { photoId: 'TEST-photo-2' }],
      },
    });
  });
  it('a duplicate binding does not freeze an unavailable retained photo as READY or append a new version', () => {
    const c = bound();
    c.photo = { ...c.photo!, photoId: 'TEST-photo-2' };
    c.newLinkId = 'TEST-link-2';
    const r = request();
    if (r.operation !== 'BIND') throw new Error('TEST');
    r.expectedBasis = c.current!.basis;
    r.photo.photoId = 'TEST-photo-2';
    const added = planEvidenceBinding(r, c);
    if (!added.ok) throw new Error('TEST');
    c.current = added.evidence;
    c.currentCoverage = added.associationCoverage;
    c.currentPhotos = [{ ...context().photo!, available: false }, c.photo];
    r.expectedBasis = added.evidence.basis;
    const result = planEvidenceBinding(r, c);
    expect(result).toMatchObject({
      ok: true,
      changed: false,
      evidence: { state: 'MISSING', basis: { version: 2 } },
    });
    if (!result.ok) throw new Error('TEST');
    expect(
      evidenceNeedsReview(result.evidence, {
        target,
        basis: result.evidence.basis,
      }),
    ).toBe(true);
  });
  it('does not append a version outside the delivered C04 boundary', () => {
    const c = bound();
    c.current = {
      ...c.current!,
      basis: { ...c.current!.basis, version: 1_000_000 },
    };
    expect(
      planEvidenceBinding(
        {
          target,
          expectedRevision: 2,
          expectedBasis: c.current.basis,
          operation: 'UNBIND',
          linkId: 'TEST-link',
        },
        c,
      ),
    ).toMatchObject({ ok: false, code: 'INVALID_IDENTITY' });
  });
  it('a duplicate with equivalent decimal spelling keeps the existing manifest text', () => {
    const c = bound(),
      r = request();
    if (r.operation !== 'BIND') throw new Error('TEST');
    r.expectedBasis = c.current!.basis;
    r.coverage.qty = '010.000001';
    expect(planEvidenceBinding(r, c)).toMatchObject({
      ok: true,
      changed: false,
      associationCoverage: { qty: '10.000001' },
      evidence: { coverage: { qty: '10.000001' } },
    });
  });
});
