import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { EvidenceWorkspace } from '../../../../packages/contracts/src/business-evidence.js';
import { ApiError } from '../api.js';
import { FactEvidenceCard, type EvidenceCardCopy } from './FactEvidenceCard.js';
import { EvidenceSession } from './evidence-session.js';

const uuid = (n: number) =>
  `10000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const target = {
  projectId: uuid(1),
  businessDate: '2026-10-06',
  crewId: uuid(2),
  foremanRevisionId: uuid(3),
  itemKey: 'TEST-install',
};
const copy: EvidenceCardCopy = {
  title: 'TEST Evidence',
  notConnected: 'TEST Not connected',
  loading: 'TEST Loading',
  declared: 'TEST Declared',
  coverage: 'TEST Covered',
  unknown: 'TEST Unknown',
  factAllowed: 'TEST Facts can be recorded without a photo',
  availabilityOnly: 'TEST Available evidence does not verify quantity',
  state: {
    MISSING: 'TEST Missing',
    PARTIAL: 'TEST Partial',
    READY: 'TEST Available',
    UNCONFIRMED_SCOPE: 'TEST Scope unconfirmed',
  },
  photo: 'TEST Photo',
  scope: 'TEST Scope',
  qty: 'TEST Quantity',
  bind: 'TEST Bind',
  unbind: 'TEST Unbind',
  retry: 'TEST Retry',
  refresh: 'TEST Refresh',
  discard: 'TEST Discard',
  pending: 'TEST Outcome pending',
  history: 'TEST Historical receipt',
  linkedPhoto: 'TEST Linked photo',
  error: (key) => `TEST message-${key}`,
};
const workspace = (): EvidenceWorkspace => ({
  target,
  revisionNumber: 2,
  declaration: { qty: '10', unit: 'TEST-m', scopeRef: uuid(4) },
  evidence: {
    target,
    basis: { linkSetId: uuid(6), version: 2 },
    state: 'READY',
    coverage: {
      scopeRef: uuid(4),
      withinScopeRef: uuid(4),
      qty: '10',
      unit: 'TEST-m',
    },
    photos: [{ photoId: uuid(7), photoVersion: 3, linkId: uuid(8) }],
  },
  associationCoverage: {
    scopeRef: uuid(4),
    withinScopeRef: uuid(4),
    qty: '10',
    unit: 'TEST-m',
  },
  availablePhotos: [
    { photoId: uuid(7), photoVersion: 3, label: 'TEST existing media' },
  ],
  scopes: [{ id: uuid(4), withinScopeRef: uuid(4), label: 'TEST whole' }],
  history: [],
  canBind: true,
});
async function loaded(data: EvidenceWorkspace, fails = false) {
  const s = new EvidenceSession(
    target,
    {
      read: async () => data,
      command: async () => {
        if (fails) throw new ApiError('NETWORK', 0);
        return {};
      },
    },
    () => uuid(9),
  );
  await s.load();
  return s;
}
const render = (session: EvidenceSession, text = copy) =>
  renderToStaticMarkup(
    createElement(FactEvidenceCard, { session, copy: text }),
  );

describe('C05 fact card renders honest availability and existing media choices', () => {
  it('shows an explicit disconnected view with no save action or fabricated evidence', () => {
    const html = render(new EvidenceSession(target, null));
    expect(html).toContain(copy.notConnected);
    expect(html).toContain(copy.factAllowed);
    expect(html).not.toContain('<input');
    expect(html).not.toContain(copy.bind);
    expect(html).not.toContain(`<p role="status">${copy.state.READY}</p>`);
  });
  it('shows raw declared quantity and availability wording, with only existing photo/scope choices', async () => {
    const html = render(await loaded(workspace()));
    expect(html).toContain('TEST Declared: 10 TEST-m');
    expect(html).toContain('TEST Covered: 10 TEST-m');
    expect(html).toContain(copy.state.READY);
    expect(html).toContain(copy.availabilityOnly);
    expect(html).toContain('TEST existing media');
    expect(html).toContain('<select');
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain('verifiedQty');
  });
  it.each(['', 'unknown', 'na', '0'])(
    'preserves declared %s without generating verified quantity',
    async (qty) => {
      const data = workspace();
      data.declaration.qty = qty;
      data.evidence = null;
      const html = render(await loaded(data));
      expect(html).toContain(`TEST Declared: ${qty || copy.unknown} TEST-m`);
      expect(html).toContain(copy.state.MISSING);
      expect(html).toContain(copy.factAllowed);
    },
  );
  it('displays a missing current set and the exact old historical quantity/photo receipt', async () => {
    const data = workspace();
    data.history = [
      {
        ...data.evidence!,
        basis: { linkSetId: uuid(6), version: 1 },
        state: 'PARTIAL',
        coverage: { ...data.evidence!.coverage!, qty: '4' },
      },
    ];
    data.evidence = null;
    const html = render(await loaded(data));
    expect(html).toContain(copy.state.MISSING);
    expect(html).toContain(copy.history);
    expect(html).toContain('TEST Partial: 4 TEST-m');
    expect(html).toContain(copy.linkedPhoto);
    expect(data.history[0]!.coverage!.qty).toBe('4');
  });
  it('read-only viewers see evidence but no bind/unbind controls', async () => {
    const html = render(await loaded({ ...workspace(), canBind: false }));
    expect(html).toContain(copy.linkedPhoto);
    expect(html).not.toContain('<input');
    expect(html).not.toContain(copy.bind);
    expect(html).not.toContain(copy.unbind);
  });
  it('shows partial covered quantity and incomplete fields without replacing the declaration', async () => {
    const data = workspace();
    data.evidence = { ...data.evidence!, state: 'PARTIAL', coverage: null };
    data.associationCoverage = {
      scopeRef: uuid(4),
      withinScopeRef: uuid(4),
      qty: null,
      unit: 'TEST-m',
    };
    const html = render(await loaded(data));
    expect(html).toContain('TEST Declared: 10 TEST-m');
    expect(html).toContain('TEST Covered: TEST Unknown TEST-m');
    expect(html).toContain('TEST Scope: TEST whole');
    expect(html).toContain(copy.state.PARTIAL);
  });
  it('hides mutable forms while the original payload is owned and exposes exact retry/discard', async () => {
    const s = await loaded(workspace(), true),
      base = s.data!;
    await s.bind(
      base.availablePhotos[0]!,
      { scopeRef: uuid(4), withinScopeRef: uuid(4), qty: '3', unit: 'TEST-m' },
      base,
    );
    const html = render(s);
    expect(html).toContain(copy.pending);
    expect(html).toContain('TEST Quantity: 3 TEST-m');
    expect(html).toContain(copy.retry);
    expect(html).toContain(copy.discard);
    expect(html).not.toContain('<input');
    expect(html).not.toContain(copy.unbind);
    expect(html).toContain('TEST message-fu_network');
  });
  it('uses the host Chinese copy without exposing raw server refusal codes', async () => {
    const s = await loaded(workspace());
    s.list.error = 'TEST_INTERNAL_FAILURE';
    const html = render(s, {
      ...copy,
      title: '照片关联',
      availabilityOnly: '照片可用不等于完成量已核实',
      factAllowed: '无照片仍可记录事实',
      error: () => '请重新读取',
    });
    expect(html).toContain('照片关联');
    expect(html).toContain('无照片仍可记录事实');
    expect(html).toContain('请重新读取');
    expect(html).not.toContain('TEST_INTERNAL_FAILURE');
  });
});
