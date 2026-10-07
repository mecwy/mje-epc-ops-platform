import { describe, it, expect } from 'vitest';
import {
  blankDraft,
  freezeWrite,
  ContractDrafts,
  mergeRevision,
  confirmedShares,
} from './drafts.js';
describe('contract drafts and immutable retry ownership', () => {
  it('isolates accounts sharing one browser even when Person and project are the same', () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
    };
    const a = new ContractDrafts(storage, 'TEST-account-a'),
      b = new ContractDrafts(storage, 'TEST-account-b');
    const draft = blankDraft('INCOME', () => 'TEST-contract');
    draft.revision.name = 'TEST private input';
    a.save(draft);
    expect(b.last()).toBeNull();
    expect(a.last()?.revision.name).toBe('TEST private input');
    b.remove('TEST-contract');
    expect(a.last()).not.toBeNull();
  });
  it('does not reinterpret a frozen retry after draft fields or expected version change', () => {
    const draft = blankDraft('INCOME', () => 'TEST-contract');
    draft.version = 7;
    draft.reason = 'TEST correction';
    draft.revision.total = { state: 'VALUE', value: '0' };
    const pending = freezeWrite(draft, 'TEST-key');
    draft.version = 8;
    draft.revision.total.value = '99.9999';
    expect(pending.body.expectedVersion).toBe(7);
    expect(pending.body.clientMutationId).toBe('TEST-key');
    expect(pending.body.revision.total.value).toBe('0');
  });
  it('retains concurrent lines/sources and requires an explicit field choice for conflicting edits', () => {
    const base = blankDraft('INCOME', () => 'id').revision;
    const line = {
      id: 'line1',
      lineNo: '1',
      description: 'TEST base',
      quantity: { state: 'UNKNOWN' as const, value: null },
      unitRaw: 'TEST',
      unit: null,
      pricingType: 'UNKNOWN' as const,
      amount: { state: 'UNKNOWN' as const, value: null },
      includes: '',
      excludes: '',
      derivation: '',
      source: null,
      removed: false,
      removalSource: null,
    };
    base.lines = [line];
    const mine = structuredClone(base),
      latest = structuredClone(base);
    mine.lines[0]!.description = 'TEST mine';
    latest.lines[0]!.description = 'TEST latest';
    latest.lines.push({ ...line, id: 'line2', lineNo: '2' });
    mine.sources = [{ sourceDocumentId: 'doc1', location: 'TEST page1' }];
    latest.sources = [{ sourceDocumentId: 'doc2', location: 'TEST page2' }];
    const merge = mergeRevision(base, mine, latest);
    expect(merge.conflicts.map((c) => c.key)).toEqual([
      'line:line1:description',
    ]);
    expect(merge.revision.lines).toHaveLength(2);
    expect(merge.revision.sources).toHaveLength(2);
    const resolved = mergeRevision(base, mine, latest, {
      'line:line1:description': 'mine',
    });
    expect(resolved.conflicts).toHaveLength(0);
    expect(resolved.revision.lines[0]!.description).toBe('TEST mine');
  });
  it('does not invent conflicts or duplicate source bindings from JSONB property order', () => {
    const base = blankDraft('INCOME', () => 'id').revision;
    base.sources = [{ sourceDocumentId: 'TEST-doc', location: 'TEST page1' }];
    base.headLocs.parties = base.sources[0]!;
    const mine = structuredClone(base),
      latest = structuredClone(base);
    latest.sources = [{ location: 'TEST page1', sourceDocumentId: 'TEST-doc' }];
    latest.headLocs.parties = latest.sources[0]!;
    expect(mergeRevision(base, mine, latest).conflicts).toHaveLength(0);
    expect(mergeRevision(base, mine, latest).revision.sources).toHaveLength(1);
  });
  it('keeps the source decision explicit when parallel edits combine assertions from different sources', () => {
    const base = blankDraft('INCOME', () => 'id').revision;
    base.lines = [
      {
        id: 'TEST-line',
        lineNo: '1',
        description: 'TEST scope',
        quantity: { state: 'VALUE', value: '1.000000' },
        unitRaw: 'TEST m',
        unit: 'm',
        pricingType: 'UNIT_PRICE',
        amount: { state: 'VALUE', value: '1.0000' },
        includes: '',
        excludes: '',
        derivation: '',
        source: { sourceDocumentId: 'TEST-base', location: 'TEST base' },
        removed: false,
        removalSource: null,
      },
    ];
    const mine = structuredClone(base),
      latest = structuredClone(base);
    mine.lines[0]!.quantity.value = '2.000000';
    mine.lines[0]!.source = {
      sourceDocumentId: 'TEST-mine',
      location: 'TEST mine',
    };
    latest.lines[0]!.amount.value = '3.0000';
    latest.lines[0]!.source = {
      sourceDocumentId: 'TEST-latest',
      location: 'TEST latest',
    };
    const merge = mergeRevision(base, mine, latest);
    expect(merge.revision.lines[0]!.quantity.value).toBe('2.000000');
    expect(merge.revision.lines[0]!.amount.value).toBe('3.0000');
    expect(merge.conflicts.map((c) => c.key)).toContain(
      'line:TEST-line:source',
    );
  });
});

describe('review F3 assertion-group conflicts', () => {
  it('requires an explicit header group choice when parallel assertions have different sources', () => {
    const base = blankDraft('INCOME', () => 'id').revision;
    const a = { sourceDocumentId: 'TEST-A', location: 'TEST page A' };
    const b = { sourceDocumentId: 'TEST-B', location: 'TEST page B' };
    base.headLocs.parties = a;
    base.name = 'TEST base';
    const mine = structuredClone(base),
      latest = structuredClone(base);
    mine.counterpartyRaw = 'TEST mine';
    mine.headLocs.parties = b;
    latest.name = 'TEST other';
    const merge = mergeRevision(base, mine, latest);
    expect(merge.conflicts.map((c) => c.key)).toContain('header:parties');
    const resolved = mergeRevision(base, mine, latest, {
      'header:parties': 'mine',
    });
    expect(resolved.revision.name).toBe('TEST base');
    expect(resolved.revision.counterpartyRaw).toBe('TEST mine');
    expect(resolved.revision.headLocs.parties).toEqual(b);
  });
  it('requires a whole-line choice for removal racing an edit in either direction', () => {
    const base = blankDraft('INCOME', () => 'id').revision;
    base.lines = [
      {
        id: 'TEST-L',
        lineNo: '1',
        description: 'TEST base',
        quantity: { state: 'UNKNOWN', value: null },
        unitRaw: '',
        unit: null,
        pricingType: 'UNKNOWN',
        amount: { state: 'UNKNOWN', value: null },
        includes: '',
        excludes: '',
        derivation: '',
        source: null,
        removed: false,
        removalSource: null,
      },
    ];
    const edited = structuredClone(base),
      removed = structuredClone(base);
    edited.lines[0]!.description = 'TEST edit';
    removed.lines[0]!.removed = true;
    removed.lines[0]!.removalSource = {
      sourceDocumentId: 'TEST-doc',
      location: 'TEST removal',
    };
    for (const [mine, latest] of [
      [edited, removed],
      [removed, edited],
    ]) {
      const result = mergeRevision(base, mine!, latest!);
      expect(result.conflicts.map((c) => c.key)).toContain('line:TEST-L');
      expect(
        mergeRevision(base, mine!, latest!, { 'line:TEST-L': 'mine' }).revision
          .lines[0],
      ).toEqual(mine!.lines[0]);
    }
  });
});

it('F1 only confirms explicitly chosen shares, leaving active reconciliation and retired history untouched', () => {
  const row = {
    scopeId: 'A',
    projectId: 'TEST-P',
    expectedVersion: 1,
    basis: 'NOTE' as const,
    quantity: null,
    area: '',
    note: '',
    retired: false,
    reason: '',
  };
  const rows = [
    row,
    { ...row, scopeId: 'retired', retired: true },
    { ...row, scopeId: 'new', expectedVersion: 0 },
  ];
  expect(confirmedShares(rows, new Set())).toEqual([]);
  const sent = confirmedShares(rows, new Set(['new']));
  expect(sent.map((s) => s.scopeId)).toEqual(['new']);
  sent[0]!.note = 'TEST mutate';
  expect(rows[2]!.note).toBe('');
  expect(confirmedShares(rows, new Set(['A']))[0]!.expectedVersion).toBe(1);
});
