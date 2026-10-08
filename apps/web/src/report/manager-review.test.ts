/** Synthetic TEST static rendering and payload checks; phone/browser UAT remains NOT_RUN. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api.js';
import { I18nProvider } from '../i18n.js';
import {
  ManagerReview,
  MANAGER_REVIEW_COPY,
  managerReviewInput,
} from './ManagerReview.js';
import {
  ManagerReviewSession,
  type ManagerReviewRead,
} from './review-session.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const target = {
  projectId: id(1),
  businessDate: '2026-10-05',
  crewId: id(2),
  foremanRevisionId: id(3),
  itemKey: 'TEST_work',
};
const data = (): ManagerReviewRead => ({
  actorScopeKey: 'TEST_actor',
  target: { ...target },
  revisionNumber: 1,
  reviewVersion: 0,
  declaredQty: '100',
  labels: { crew: 'TEST crew', item: 'TEST work', scope: 'TEST scope' },
  unit: 'TEST_unit',
  scopeRef: id(5),
  capability: {
    basisRef: id(6),
    actions: ['RETURN', 'INCONCLUSIVE', 'CONFIRM_SCOPE'],
  },
  evidence: {
    target: { ...target },
    basis: { linkSetId: id(4), version: 1 },
    state: 'PARTIAL',
    coverage: {
      scopeRef: id(7),
      withinScopeRef: id(5),
      qty: '40',
      unit: 'TEST_unit',
    },
    photos: [{ photoId: id(8), photoVersion: 1, linkId: id(9) }],
  },
  state: {
    target: { ...target },
    status: 'NOT_CHECKED',
    coverage: 'NONE',
    confirmedQty: null,
    unit: null,
    eventId: null,
    reviewVersion: 0,
  },
  judgment: null,
});
const values = {
  decision: 'RETURN' as const,
  partial: false,
  qty: '',
  reason: 'TEST fix',
  method: '',
  limitations: '',
};
async function setup(d = data(), lose = false) {
  let failRelease = false;
  const session = new ManagerReviewSession(
    target,
    'TEST_actor',
    {
      read: async () => d,
      write: async () => {
        if (lose) throw new ApiError('NETWORK', 0);
      },
    },
    {
      holds: () => true,
      acquire: () => true,
      prepare: async () => 'ok' as const,
      abandon: () => undefined,
      release: async () => !failRelease,
    },
    () => id(10),
  );
  await session.load();
  const html = () =>
    renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(ManagerReview, { session, copy: MANAGER_REVIEW_COPY.en }),
      ),
    );
  return {
    session,
    html,
    failRelease: () => {
      failRelease = true;
    },
  };
}
describe('C04 manager review displayed semantics and frozen input', () => {
  it('shows original quantity and partial evidence without claiming confirmation', async () => {
    const r = await setup();
    const html = r.html();
    expect(html).toContain('100 TEST_unit');
    expect(html).toContain('40 TEST_unit');
    expect(html).toContain('Not checked');
    expect(html).not.toContain('Checked quantity:');
    expect(html).toContain(
      'Declaration, adoption, quality acceptance and billing are separate.',
    );
  });
  it.each(['', '0', 'unknown', 'na'])(
    'source %s keeps its own display meaning',
    async (raw) => {
      const d = data();
      d.declaredQty = raw;
      const r = await setup(d);
      const shown =
        raw === ''
          ? 'Blank'
          : raw === 'unknown'
            ? 'Unknown'
            : raw === 'na'
              ? 'Not applicable'
              : '0';
      expect(r.html()).toContain(`Declared quantity: ${shown} TEST_unit`);
    },
  );
  it('whole confirmation references the original quantity without a new quantity field', () => {
    const d = data();
    d.evidence!.state = 'READY';
    d.evidence!.coverage!.scopeRef = d.scopeRef!;
    const command = managerReviewInput(d, {
      ...values,
      decision: 'CONFIRM_SCOPE',
      method: 'TEST observed',
    });
    expect(command.coverage).toEqual({ kind: 'WHOLE' });
    expect(command).not.toHaveProperty('qty');
    d.target.foremanRevisionId = id(30);
    d.evidence!.basis.version = 2;
    expect(command.target.foremanRevisionId).toBe(id(3));
    expect(command.evidenceBasis?.version).toBe(1);
  });
  it('partial confirmation uses the actual evidence scope and preserves decimal text', () => {
    const d = data();
    const command = managerReviewInput(d, {
      ...values,
      decision: 'CONFIRM_SCOPE',
      partial: true,
      qty: '12.000001',
      method: 'TEST observed',
    });
    expect(command.coverage).toEqual({
      kind: 'PARTIAL',
      scopeRef: id(7),
      qty: '12.000001',
    });
  });
  it.each(['RETURN', 'INCONCLUSIVE'] as const)(
    '%s carries reasons and no confirmed quantity',
    (decision) => {
      expect(managerReviewInput(data(), { ...values, decision })).toMatchObject(
        { decision, reason: 'TEST fix', coverage: null },
      );
    },
  );
  it('missing actual C05 evidence disables confirmation but keeps authorized return visible', async () => {
    const d = data();
    d.evidence = null;
    const r = await setup(d);
    const html = r.html();
    expect(html).toContain('value="CONFIRM_SCOPE" disabled=""');
    expect(html).toContain('value="RETURN"');
    expect(html).not.toContain('Checked quantity:');
  });
  it('pending and lost-role surfaces retain read-only payload and original retry/discard', async () => {
    const d = data();
    const r = await setup(d, true);
    await r.session.start(managerReviewInput(d, values));
    d.capability = { basisRef: null, actions: [] };
    d.declaredQty = '80';
    await r.session.load();
    const html = r.html();
    expect(html).toContain('may or may not have been recorded');
    expect(html).toContain('TEST fix');
    expect(html).toContain('Declared quantity: 100 TEST_unit');
    expect(html).toContain('Retry original');
    expect(html).toContain('Give up and refresh');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('did not succeed');
  });
  it('a post-write day read failure shows saved-stale and no editable form', async () => {
    const r = await setup();
    r.failRelease();
    await r.session.start(managerReviewInput(data(), values));
    expect(r.html()).toContain(
      'Judgment saved; refresh is required before editing',
    );
    expect(r.html()).not.toContain('<textarea');
  });
  it('HTML escapes source text and never echoes an unknown error code', async () => {
    const d = data();
    d.target.itemKey = 'TEST_work';
    d.declaredQty = '<script>TEST</script>';
    const r = await setup(d);
    r.session.localError = 'TEST_PRIVATE_ERROR_TEXT';
    expect(r.html()).toContain('&lt;script&gt;TEST&lt;/script&gt;');
    expect(r.html()).not.toContain('TEST_PRIVATE_ERROR_TEXT');
  });
});
