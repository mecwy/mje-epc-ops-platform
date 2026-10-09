import { describe, expect, it } from 'vitest';
import type {
  ActivityMaterialMapping,
  ReportActivity,
  ReportItemDto,
} from '@mje/contracts';
import {
  admitActivities,
  confirmActivityUses,
  activityDeclaredConsumption,
  activityOutputQuantities,
} from './report-activities.js';
import { blankFacts, coverage } from './report-rules.js';

const uuid = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const mapping: ActivityMaterialMapping = {
  orgId: uuid(1),
  projectId: uuid(2),
  workItemId: uuid(3),
  materialItemId: uuid(4),
  validFrom: '2030-01-01',
  basisRef: 'TEST explicit scope mapping',
  workPackageId: 'TEST-package',
  scopeVersion: '1',
  area: 'TEST-area',
  workItemKey: 'testInstall',
  materialKey: 'testMounts',
  specification: 'TEST-spec',
  outputUnit: 'set',
  materialUnit: 'set',
  ruleId: 'TEST-one-to-one',
  ruleVersion: '1',
  mappingVersion: '1',
  ratio: '1',
};
const items: (ReportItemDto & { id: string })[] = [
  {
    id: uuid(3),
    kind: 'work',
    key: 'testInstall',
    label: 'TEST installation',
    unit: 'set',
    designQty: '10000',
    openingCumulative: '',
    sortOrder: 1,
    active: true,
  },
  {
    id: uuid(4),
    kind: 'material',
    key: 'testMounts',
    label: 'TEST mounts',
    unit: 'set',
    designQty: '10000',
    openingCumulative: '',
    sortOrder: 1,
    active: true,
  },
];
function activity(n = 10): ReportActivity {
  return {
    operationId: uuid(n),
    outputFactId: uuid(n + 1),
    workItemId: uuid(3),
    workItemKey: 'testInstall',
    workPackageId: 'TEST-package',
    scopeVersion: '1',
    area: 'TEST-area',
    process: 'TEST installation',
    completion: '',
    outputUnit: 'set',
    quantity: '368',
    outputKind: 'installation',
    use: {
      id: uuid(n + 2),
      materialKey: 'testMounts',
      materialItemId: uuid(4),
      specification: 'TEST-spec',
      unit: 'set',
      actualQuantity: '',
      state: 'calculated',
      origin: 'calculated',
      differenceNote: '',
      reviewRequired: false,
      confirmation: null,
      estimate: {
        quantity: '368',
        ruleId: mapping.ruleId,
        ruleVersion: '1',
        mappingVersion: '1',
        scopeRef: 'TEST-package@1',
        outputFactId: uuid(n + 1),
        outputQuantity: '368',
        workItemKey: 'testInstall',
        materialKey: 'testMounts',
        specification: 'TEST-spec',
        outputUnit: 'set',
        materialUnit: 'set',
        ratio: '1',
      },
    },
  };
}
const actor = { accountId: uuid(100), personId: uuid(101) };
const at = '2030-01-02T12:00:00.000Z';
const confirm = (rows: ReportActivity[]) => ({
  draftVersion: 7,
  includedUseFactIds: rows.flatMap((a) =>
    a.use && a.use.state !== 'pending' ? [a.use.id] : [],
  ),
});

describe('activity output and material declaration boundary', () => {
  it('AM1 keeps estimate out of draft declared totals, then confirms exactly once with server actor/time', () => {
    const draft = admitActivities([activity()], [], items, [mapping]);
    expect(activityDeclaredConsumption(draft)).toEqual({});
    const submitted = confirmActivityUses(draft, confirm(draft), 7, actor, at);
    expect(activityDeclaredConsumption(submitted)).toEqual({
      testMounts: '368',
    });
    expect(submitted[0]!.use!.confirmation).toEqual({ ...actor, at });
    expect(submitted[0]!.use!.origin).toBe('calculated');
    expect(draft[0]!.use!.state).toBe('calculated');
    expect(submitted[0]!.use).not.toHaveProperty('verified');
  });
  it('AM2 allows manual370 and does not invent loss from the difference', () => {
    const a = activity();
    a.use!.actualQuantity = '370';
    a.use!.state = 'edited';
    a.use!.origin = 'manual';
    a.use!.differenceNote = 'TEST reporter explanation';
    const draft = admitActivities([a], [], items, [mapping]);
    const submitted = confirmActivityUses(draft, confirm(draft), 7, actor, at);
    expect(activityOutputQuantities(submitted)).toEqual({ testInstall: '368' });
    expect(activityDeclaredConsumption(submitted)).toEqual({
      testMounts: '370',
    });
    expect(submitted[0]!.use!.differenceNote).toBe('TEST reporter explanation');
    expect(submitted[0]!.use).not.toHaveProperty('loss');
  });
  it('AM3 submits output with pending use without adopting the estimate or zero', () => {
    const a = activity();
    a.use!.state = 'pending';
    const result = confirmActivityUses([a], confirm([a]), 7, actor, at);
    expect(result[0]!.quantity).toBe('368');
    expect(result[0]!.use!.state).toBe('pending');
    expect(result[0]!.use!.actualQuantity).toBe('');
    expect(result[0]!.use!.estimate!.quantity).toBe('368');
    expect(activityDeclaredConsumption(result)).toEqual({});
  });
  it('keeps unassigned materials pending, without inventing a material identity', () => {
    const a = activity();
    a.use!.materialKey = null;
    a.use!.materialItemId = null;
    a.use!.unit = '';
    a.use!.estimate = null;
    a.use!.state = 'pending';
    expect(
      admitActivities([a], [], items, [mapping])[0]!.use!.materialKey,
    ).toBeNull();
    expect(
      confirmActivityUses([a], confirm([a]), 7, actor, at)[0]!.use!.state,
    ).toBe('pending');
  });
  it('AM4 retains declared368 when output changes to360 and requires review; old snapshot is unchanged', () => {
    const old = confirmActivityUses(
      [activity()],
      confirm([activity()]),
      7,
      actor,
      at,
    );
    const next = structuredClone(old);
    next[0]!.quantity = '360';
    const admitted = admitActivities(next, old, items, [mapping]);
    expect(admitted[0]!.use!.actualQuantity).toBe('368');
    expect(admitted[0]!.use!.reviewRequired).toBe(true);
    expect(old[0]!.quantity).toBe('368');
    expect(old[0]!.use!.reviewRequired).toBe(false);
  });
  it('rejects forged declarations and forged confirmation actor/time', () => {
    const a = activity();
    a.use!.state = 'declared';
    a.use!.actualQuantity = '368';
    a.use!.confirmation = { ...actor, at };
    expect(() => admitActivities([a], [], items, [mapping])).toThrow();
    const old = confirmActivityUses(
      [activity()],
      confirm([activity()]),
      7,
      actor,
      at,
    );
    const forged = structuredClone(old);
    forged[0]!.use!.confirmation!.personId = uuid(999);
    expect(() => admitActivities(forged, old, items, [mapping])).toThrow();
  });
  it('round-trips JSONB key order and stamps only declared confirmation fields', () => {
    const contextActor = { ...actor, orgId: uuid(1) };
    const submitted = confirmActivityUses(
      [activity()],
      confirm([activity()]),
      7,
      contextActor,
      at,
    );
    expect(submitted[0]!.use!.confirmation).toEqual({ ...actor, at });
    const persisted = JSON.parse(
      JSON.stringify(submitted, (_key, v: unknown) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).reverse())
          : v,
      ),
    ) as ReportActivity[];
    const next = structuredClone(submitted);
    next[0]!.quantity = '360';
    expect(
      admitActivities(next, persisted, items, [mapping])[0]!.use!
        .actualQuantity,
    ).toBe('368');
    const draft = [activity()];
    const stored = JSON.parse(
      JSON.stringify(draft, (_key, v: unknown) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).reverse())
          : v,
      ),
    ) as ReportActivity[];
    expect(admitActivities(draft, stored, items, [])[0]!.use!.estimate).toEqual(
      draft[0]!.use!.estimate,
    );
  });
  it('counts valid construction cards without repeated narrative; retains other requirements and rejects empty/malformed cards', () => {
    const check = (activities?: ReportActivity[], construction = '') => {
      const facts = {
        ...blankFacts(),
        activities,
        narrative: { construction, quality: '', safety: '' },
      };
      return coverage({
        facts,
        itemIds: ['testInstall'],
        materialIds: [],
        machineryIds: [],
        photographedItems: new Set(),
        baseline: null,
      }).missing.map((m) => m.key);
    };
    const admitted = admitActivities([activity()], [], items, [mapping]);
    expect(check(admitted)).not.toContain('construction');
    expect(check(admitted)).toContain('quality');
    expect(check(admitted)).toContain('safety');
    const empty = activity();
    empty.quantity = '';
    empty.use = null;
    expect(check([empty])).toContain('construction');
    const malformed = { ...activity(), operationId: 'invalid' };
    expect(check([malformed])).toContain('construction');
    const described = activity();
    described.quantity = '';
    described.outputKind = 'activity';
    described.completion = 'TEST perimeter protection completed';
    described.use = null;
    expect(check([described])).not.toContain('construction');
    expect(check(undefined, 'TEST legacy construction text')).not.toContain(
      'construction',
    );
    expect(check()).toContain('construction');
  });
  it.each(['scopeVersion', 'area', 'workItemId'] as const)(
    'does not estimate under a changed mapping %s',
    (field) => {
      const a = activity();
      a[field] = field === 'workItemId' ? uuid(900) : 'other';
      expect(() => admitActivities([a], [], items, [mapping])).toThrow();
    },
  );
  it('cannot reuse an old calculated basis in another area; retained manual declarations remain provenance', () => {
    const old = [activity()];
    const changed = structuredClone(old);
    changed[0]!.area = 'TEST different area';
    expect(() => admitActivities(changed, old, items, [])).toThrow();
    changed[0]!.use!.state = 'edited';
    changed[0]!.use!.origin = 'manual';
    changed[0]!.use!.actualQuantity = '370';
    expect(
      admitActivities(changed, old, items, [])[0]!.use!.actualQuantity,
    ).toBe('370');
  });
  it('requires the exact saved version and exact non-pending set; legacy submit cannot promote use', () => {
    const a = activity();
    for (const intent of [
      undefined,
      { draftVersion: 6, includedUseFactIds: [a.use!.id] },
      { draftVersion: 7, includedUseFactIds: [] },
      { draftVersion: 7, includedUseFactIds: [uuid(999)] },
      { draftVersion: 7, includedUseFactIds: [a.use!.id, a.use!.id] },
    ])
      expect(() => confirmActivityUses([a], intent, 7, actor, at)).toThrow();
  });
  it('AM5 distinguishes two same-day operations and excludes real predecessor368 quantities', () => {
    const second = activity(20);
    const predecessor = activity(30);
    predecessor.outputKind = 'process';
    predecessor.use = null;
    const noQuantity = activity(40);
    noQuantity.outputKind = 'activity';
    noQuantity.quantity = '';
    noQuantity.use = null;
    const rows = admitActivities(
      [activity(), second, predecessor, noQuantity],
      [],
      items,
      [mapping],
    );
    expect(activityOutputQuantities(rows)).toEqual({ testInstall: '736' });
    expect(rows[2]!.quantity).toBe('368');
    expect(rows[3]!.quantity).toBe('');
    expect(() =>
      admitActivities([activity(), activity()], [], items, [mapping]),
    ).toThrow();
  });
});

it('an existing material use keeps its scope identity even when its estimate is removed', () => {
  const before = activity();
  before.use!.estimate = null;
  before.use!.state = 'pending';
  before.use!.origin = 'manual';
  for (const change of [{ workPackageId: 'TEST-other' }, { scopeVersion: '2' }])
    expect(() =>
      admitActivities(
        [{ ...structuredClone(before), ...change }],
        [before],
        items,
        [mapping],
      ),
    ).toThrow();
});
