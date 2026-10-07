import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  parseInstallationCumulative,
  parseSaveFactsCommand,
  type InstallationAnchor,
} from '@mje/contracts';
import {
  buildInstallationCumulative,
  blankFacts,
  installationToday,
  type InstallationHistoryInput,
} from './report-rules.js';
import { installationHistory } from './report-store.js';
import { readerContent, readerSnapshot } from './report-reader.js';
import type { Actor } from './store-kit.js';
const projectId = '10000000-0000-4000-8000-000000000001';
const otherProject = '10000000-0000-4000-8000-000000000002';
const id = (n: number) =>
  `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const baseline: InstallationAnchor = {
  kind: 'complete-baseline',
  unit: '',
  value: '100',
  asOf: '2026-10-05',
  referenceId: id(10),
};
function row(
  date: string,
  qty: string,
  cumulative = '',
): InstallationHistoryInput {
  return {
    projectId,
    businessDate: date,
    revisionId: id(Number(date.slice(-2))),
    n: 1,
    qty: { rack: qty },
    cumulative: { rack: cumulative },
  };
}
function calc(
  history: InstallationHistoryInput[] = [],
  today = '10',
  complete?: InstallationAnchor,
) {
  return buildInstallationCumulative({
    projectId,
    businessDate: '2026-10-06',
    selectedAtUTC: '2026-10-06T12:00:00.000Z',
    workKeys: ['rack'],
    history,
    todayQty: { rack: today },
    ...(complete ? { completeBaselines: { rack: complete } } : {}),
  });
}
describe('N4 independent installation cumulative contract', () => {
  it('uses an explicit complete prior-day anchor; no raw/source declaration is synthesized', () => {
    const facts = { ...blankFacts(), qty: { rack: '10' }, cumulative: {} };
    const before = structuredClone(facts);
    const summary = calc([], facts.qty.rack, baseline);
    expect(summary.items[0]).toMatchObject({
      state: 'complete',
      value: '110',
      knownSubtotal: '110',
      priorKnownSubtotal: '100',
    });
    expect(facts).toEqual(before);
    expect(summary.currentRevision).toBeNull();
  });
  it('numeric original declarations are partial even on the previous day, never complete', () => {
    expect(calc([row('2026-10-05', '10', '100')]).items[0]).toMatchObject({
      state: 'partial',
      value: null,
      knownSubtotal: '110',
      anchor: { kind: 'declared' },
    });
  });
  it('old anchor plus missing date shows subtotal only', () => {
    const summary = calc([], '10', { ...baseline, asOf: '2026-10-04' });
    expect(summary.items[0]).toMatchObject({
      state: 'partial',
      value: null,
      knownSubtotal: '110',
      missingDays: 1,
    });
  });
  it('explicit zero is coverage, while a blank on even a no-work day remains unknown', () => {
    expect(
      calc([row('2026-10-05', '0')], '0', { ...baseline, asOf: '2026-10-04' })
        .items[0],
    ).toMatchObject({ state: 'complete', value: '100' });
    expect(
      calc([row('2026-10-05', '')], '0', { ...baseline, asOf: '2026-10-04' })
        .items[0],
    ).toMatchObject({ state: 'partial', value: null, unknownDays: 1 });
  });
  it.each(['', 'unknown'])(
    'unknown today %s never becomes zero or a complete total',
    (today) => {
      expect(calc([], today, baseline).items[0]).toMatchObject({
        state: 'unknown',
        value: null,
        knownSubtotal: '100',
      });
    },
  );
  it('absent baseline is unknown, not an invented zero opening', () => {
    expect(calc().items[0]).toMatchObject({
      state: 'unknown',
      value: null,
      knownSubtotal: null,
      anchor: null,
    });
  });
  it('NA stays NA; an explicit historical NA is a covered non-contribution', () => {
    expect(calc([], 'na', baseline).items[0].state).toBe('na');
    expect(
      calc([row('2026-10-05', 'na')], '10', { ...baseline, asOf: '2026-10-04' })
        .items[0].value,
    ).toBe('110');
  });
  it('uses latest selected correction once, and records only that version in lineage', () => {
    const one = row('2026-10-05', '3');
    const two = { ...one, n: 2, revisionId: id(20), qty: { rack: '4' } };
    const summary = calc([one, two], '10', { ...baseline, asOf: '2026-10-04' });
    expect(summary.items[0].value).toBe('114');
    expect(summary.lineage).toEqual([
      { businessDate: '2026-10-05', revisionId: id(20), n: 2 },
    ]);
  });
  it('rejects cross-project, duplicate revision identity and contradictory same version', () => {
    expect(() =>
      calc([{ ...row('2026-10-05', '1'), projectId: otherProject }]),
    ).toThrow();
    expect(() =>
      calc([
        row('2026-10-04', '1'),
        { ...row('2026-10-05', '1'), revisionId: id(4) },
      ]),
    ).toThrow();
    expect(() =>
      calc([
        row('2026-10-05', '1'),
        { ...row('2026-10-05', '2'), revisionId: id(8) },
      ]),
    ).toThrow();
  });
  it('never uses a future/current-day history row or a baseline beyond bounded history', () => {
    expect(() => calc([row('2026-10-06', '1')])).toThrow();
    expect(() => calc([], '1', { ...baseline, asOf: '2024-10-01' })).toThrow();
  });
  it('adds decimal strings exactly and marks overflow without clipping or number', () => {
    expect(
      calc([], '0.000001', { ...baseline, value: '1.000001' }).items[0].value,
    ).toBe('1.000002');
    expect(
      calc([], '0.000001', { ...baseline, value: '99999999999999.999999' })
        .items[0],
    ).toMatchObject({ state: 'overflow', value: null, knownSubtotal: null });
  });
  it('a fresh draft preview changes only today; raw cumulative and old projection stay intact', () => {
    const summary = calc([], '10', baseline);
    const before = structuredClone(summary);
    expect(installationToday(summary.items[0]!, '20').value).toBe('120');
    expect(summary).toEqual(before);
  });
  it('does not combine historical quantities or anchors with a different unit', () => {
    const base = {
      projectId,
      businessDate: '2026-10-06',
      selectedAtUTC: '2026-10-06T12:00:00.000Z',
      workKeys: ['rack'],
      workUnits: { rack: 'set' },
      todayQty: { rack: '10' },
    };
    const wrongAnchor = {
      ...row('2026-10-04', '1', '100'),
      units: { rack: 'piece' },
    };
    expect(
      buildInstallationCumulative({ ...base, history: [wrongAnchor] }).items[0],
    ).toMatchObject({ state: 'unknown', anchor: null, knownSubtotal: null });
    const rightAnchor = { ...wrongAnchor, units: { rack: 'set' } };
    const wrongActual = {
      ...row('2026-10-05', '500'),
      units: { rack: 'piece' },
    };
    expect(
      buildInstallationCumulative({
        ...base,
        history: [rightAnchor, wrongActual],
      }).items[0],
    ).toMatchObject({ state: 'partial', knownSubtotal: '110', unknownDays: 1 });
    const rightActual = { ...wrongActual, units: { rack: 'set' } };
    expect(
      buildInstallationCumulative({
        ...base,
        history: [rightAnchor, rightActual],
      }).items[0].knownSubtotal,
    ).toBe('610');
  });
  it('records the bounded evaluation window explicitly without claiming earlier coverage', () => {
    const summary = calc([], '10', baseline);
    expect(summary).toMatchObject({
      historyLimitDays: 366,
      historyBeforeWindow: 'not-evaluated',
      historyFrom: '2025-10-05',
    });
  });
  it('the bounded projection supports100 items and rejects101 without changing item-master limits', () => {
    const keys = Array.from({ length: 100 }, (_, i) => 'work' + i);
    const input = {
      projectId,
      businessDate: '2026-10-06',
      selectedAtUTC: '2026-10-06T12:00:00Z',
      workKeys: keys,
      todayQty: {},
      history: [],
    };
    expect(buildInstallationCumulative(input).items).toHaveLength(100);
    expect(() =>
      buildInstallationCumulative({ ...input, workKeys: [...keys, 'extra'] }),
    ).toThrow();
  });
  it('strict parser rejects fake completeness, invalid IDs, hidden fields and duplicate lineage', () => {
    const partial = calc([row('2026-10-05', '1', '100')]);
    expect(() =>
      parseInstallationCumulative({
        ...partial,
        items: [{ ...partial.items[0], state: 'complete', value: '110' }],
      }),
    ).toThrow();
    expect(() =>
      parseInstallationCumulative({ ...partial, projectId: 'not-an-id' }),
    ).toThrow();
    expect(() =>
      parseInstallationCumulative({ ...partial, hidden: true }),
    ).toThrow();
    expect(() =>
      parseInstallationCumulative({
        ...partial,
        lineage: [...partial.lineage, ...partial.lineage],
      }),
    ).toThrow();
  });
  it('cannot inject computed projection into original facts', () => {
    expect(() =>
      parseSaveFactsCommand({
        projectId,
        businessDate: '2026-10-06',
        clientMutationId: id(50),
        expectedVersion: 0,
        facts: { ...blankFacts(), installationCumulative: calc() },
      }),
    ).toThrow();
  });
  it('legacy reader snapshots retain absence, new frozen projection remains exact after new history', () => {
    const facts = blankFacts();
    const legacy = {
      facts,
      items: [],
      baseline: null,
      nextPlan: { status: 'none', n: null, rows: [] },
      coverage: { missing: [], warnings: [] },
    };
    expect(readerContent(legacy, [])).not.toHaveProperty(
      'installationCumulative',
    );
    expect(readerSnapshot(legacy)).not.toHaveProperty('installationCumulative');
    const projection = calc([row('2026-10-05', '1', '100')]);
    projection.currentRevision = {
      businessDate: '2026-10-06',
      revisionId: id(60),
      n: 1,
    };
    const frozen = { ...legacy, installationCumulative: projection };
    const before = structuredClone(frozen);
    calc([{ ...row('2026-10-05', '1', '200'), n: 2, revisionId: id(61) }]);
    expect(readerContent(frozen, []).installationCumulative).toEqual(
      before.installationCumulative,
    );
    expect(readerSnapshot(frozen)).toEqual(before);
    expect(frozen).toEqual(before);
  });
  it('history query binds tenant/project/scope, excludes today and preserves submitted predecessor during correction', async () => {
    const query = vi.fn(async () => ({
      rows: [row('2026-10-05', '1', '100')],
    }));
    const actor: Actor = {
      orgId: id(80),
      accountId: id(81),
      personId: id(82),
      authzVersion: 1,
      decidedAt: '2026-10-06T12:00:00Z',
    };
    await installationHistory(
      { query } as unknown as PoolClient,
      actor,
      projectId,
      '2026-10-06',
    );
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain(
      'd."orgId"=$1 AND d."projectId"=$2 AND d."scopeKey"=$3',
    );
    expect(sql).toContain("r.state='SUBMITTED'");
    expect(sql).not.toContain("d.state='SUBMITTED'");
    expect(sql).toContain('LIMIT 366');
    expect(params).toEqual([
      actor.orgId,
      projectId,
      'report',
      '2026-10-06',
      '2025-10-05',
      actor.decidedAt,
    ]);
  });
});
