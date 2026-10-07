import { describe, expect, it } from 'vitest';
import type { ContractRevisionInput, ContractShareInput } from '@mje/contracts';
import { parseCreateContract, parseContractShares } from '@mje/contracts';
import {
  scaled,
  unscaled,
  validateRevision,
  validateShares,
  executionChanged,
  needsCorrectionAttention,
  type StoredShare,
} from './validation.js';
const doc = '11111111-1111-4111-8111-111111111111';
const lineId = '22222222-2222-4222-8222-222222222222';
const loc = { sourceDocumentId: doc, location: 'TEST p1' };
function revision(): ContractRevisionInput {
  return {
    name: 'TEST contract',
    originalNumber: null,
    counterpartyRaw: null,
    selfPartyRaw: null,
    counterpartyCompanyId: null,
    selfCompanyId: null,
    informationOwnerPersonId: null,
    signedOn: { state: 'UNKNOWN', value: null },
    effectiveOn: { state: 'NOT_STATED', value: null },
    registrationStatus: 'SIGNED_PENDING',
    total: { state: 'VALUE', value: '0.0000' },
    currency: 'EUR',
    taxBasis: 'UNKNOWN',
    sources: [loc],
    headLocs: { parties: loc, dates: null, total: loc },
    lines: [
      {
        id: lineId,
        lineNo: '1',
        description: 'TEST scope',
        quantity: { state: 'VALUE', value: '99999999999999.999999' },
        unitRaw: 'TEST pcs',
        unit: 'pcs',
        pricingType: 'UNKNOWN',
        amount: { state: 'NA', value: null },
        includes: '',
        excludes: '',
        derivation: '',
        source: loc,
        removed: false,
        removalSource: null,
      },
    ],
  };
}
function share(id: string, q: string): ContractShareInput {
  return {
    scopeId: id,
    projectId: id,
    expectedVersion: 0,
    basis: 'QUANTITY',
    quantity: q,
    area: '',
    note: '',
    retired: false,
    reason: '',
  };
}
describe('contract input and provenance', () => {
  it('treats JSONB object key order as the same assertion and source binding', () => {
    const old = revision();
    old.lines[0]!.source = { location: loc.location, sourceDocumentId: doc };
    expect(() => validateRevision(revision(), old)).not.toThrow();
  });
  it('keeps explicit zero, unknown, not stated and NA distinct', () => {
    const r = revision();
    const c = parseCreateContract({
      contractId: doc,
      code: 'TEST-C',
      direction: 'INCOME',
      expenditureSubtype: null,
      expectedVersion: 0,
      clientMutationId: lineId,
      revision: r,
    });
    expect(c.revision).toEqual(r);
    validateRevision(r, null);
    for (const bad of [
      '0,00',
      '1e2',
      '+1',
      '-1',
      '10000000000000000',
      '1.00001',
    ])
      expect(() =>
        parseCreateContract({
          ...c,
          revision: { ...r, total: { state: 'VALUE', value: bad } },
        }),
      ).toThrow();
    expect(() => parseCreateContract({ ...c, orgId: doc })).toThrow();
    expect(() =>
      parseCreateContract({
        ...c,
        revision: { ...r, total: { state: 'UNKNOWN', value: '0' } },
      }),
    ).toThrow();
  });
  it('rejects unbound changes, dropped sources and missing old lines', () => {
    const old = revision();
    validateRevision(structuredClone(old), old);
    const changed = structuredClone(old);
    changed.total = { state: 'UNKNOWN', value: null };
    changed.headLocs.total = null;
    expect(() => validateRevision(changed, old)).toThrow('SOURCE_INVALID');
    expect(() => validateRevision({ ...old, sources: [] }, old)).toThrow(
      'SOURCE_INVALID',
    );
    expect(() => validateRevision({ ...old, lines: [] }, old)).toThrow(
      'LINE_MISSING',
    );
    const rebound = structuredClone(old);
    rebound.lines[0]!.source = { ...loc, location: 'different' };
    expect(() => validateRevision(rebound, old)).toThrow('SOURCE_INVALID');
    changed.headLocs.total = loc;
    validateRevision(changed, old);
  });
  it('uses exact bounded integer arithmetic beyond JS safe integers', () => {
    expect(unscaled(scaled('9999999999999999.9999', 4) + 1n, 4)).toBe(
      '10000000000000000.0000',
    );
    expect(scaled('-0.0001', 4)).toBe(-1n);
    expect(() => scaled('1e6', 6)).toThrow('INVALID_VALUE');
    expect(() => scaled('100000000000000', 6)).toThrow('INVALID_VALUE');
  });
});
describe('fixed-version share reconciliation', () => {
  it('conserves micro-units at the database quantity limit', () => {
    const l = revision().lines[0]!;
    const a = share(doc, '99999999999999.999998'),
      b = share(lineId, '0.000001');
    expect(validateShares(l, [], [a, b])).toEqual({
      state: 'ALLOCATED',
      remaining: '0.000000',
    });
    expect(() =>
      validateShares(l, [], [a, { ...b, quantity: '0.000002' }]),
    ).toThrow('SHARE_INVALID');
    expect(validateShares(l, [], [a])).toEqual({
      state: 'PARTIAL',
      remaining: '0.000001',
    });
  });
  it('atomically requires every active share on unit change and retains old content', () => {
    const old = revision().lines[0]!;
    const current: StoredShare[] = [
      {
        ...share(doc, '1'),
        expectedVersion: 1,
        pinnedRevisionN: 1,
        pinnedLine: old,
      },
      {
        ...share(lineId, '2'),
        expectedVersion: 1,
        pinnedRevisionN: 1,
        pinnedLine: old,
      },
    ];
    const fresh = {
      ...old,
      unit: 'm' as const,
      unitRaw: 'TEST metres',
      quantity: { state: 'VALUE' as const, value: '3' },
    };
    expect(() =>
      validateShares(fresh, current, [{ ...current[0]!, quantity: '1' }]),
    ).toThrow('RECONCILE_REQUIRED');
    expect(validateShares(fresh, current, current)).toEqual({
      state: 'ALLOCATED',
      remaining: '0.000000',
    });
    expect(current[0]!.pinnedLine.unit).toBe('pcs');
    expect(() =>
      validateShares(fresh, current, [
        { ...current[0]!, expectedVersion: 0 },
        current[1]!,
      ]),
    ).toThrow('VERSION_CONFLICT');
  });
  it('disallows a whole share mixed with any other and unknown quantity allocation', () => {
    const l = revision().lines[0]!;
    const a = { ...share(doc, '1'), basis: 'WHOLE' as const, quantity: null };
    expect(() => validateShares(l, [], [a, share(lineId, '1')])).toThrow(
      'SHARE_INVALID',
    );
    expect(() =>
      validateShares({ ...l, unit: null }, [], [share(doc, '1')]),
    ).toThrow('SHARE_INVALID');
    expect(() => validateShares({ ...l, removed: true }, [], [a])).toThrow(
      'SHARE_INVALID',
    );
    expect(
      executionChanged(l, { ...l, amount: { state: 'VALUE', value: '4' } }),
    ).toBe(false);
    expect(
      executionChanged(l, { ...l, includes: 'TEST additional scope' }),
    ).toBe(true);
  });
  it('strictly binds positive contract and per-share versions', () => {
    const c = {
      contractId: doc,
      lineId,
      expectedVersion: 1,
      clientMutationId: doc,
      shares: [share(doc, '0.000001')],
    };
    expect(parseContractShares(c)).toEqual(c);
    expect(() => parseContractShares({ ...c, expectedVersion: 0 })).toThrow();
    expect(() =>
      parseContractShares({ ...c, shares: [share(doc, '0')] }),
    ).toThrow();
  });
});

it('review F4 treats equivalent decimal line amounts as the same sourced assertion', () => {
  const old = revision(),
    next = structuredClone(old);
  old.lines[0]!.amount = { state: 'VALUE', value: '1.0000' };
  next.lines[0]!.amount = { state: 'VALUE', value: '1' };
  expect(needsCorrectionAttention(next, old)).toBe(false);
  expect(() => validateRevision(next, old)).not.toThrow();
  next.lines[0]!.amount = { state: 'VALUE', value: '1.0001' };
  expect(needsCorrectionAttention(next, old)).toBe(true);
});
