import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanRowDto } from '@mje/contracts';
import { LOCALES, translate, type Lang } from '@mje/ui';
import { ApiError, type DayView, type PlanView } from '../api.js';
import { I18nProvider } from '../i18n.js';
import { PlanEditor } from './PlanEditor.js';
import { PlanQuantityEntry, PlanSession } from './plan-session.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const view = (rows: PlanRowDto[]): PlanView => ({
  targetBusinessDate: 'T',
  status: { status: 'none', n: null },
  rows,
  draft: null,
  versions: [],
});
function fakeApi(initial: PlanRowDto[]) {
  const saves: { rows: PlanRowDto[]; release: () => void }[] = [];
  const confirms: PlanRowDto[][] = [];
  let server = initial;
  let confirmed: PlanRowDto[] | null = null;
  return {
    saves,
    confirms,
    api: {
      plan: async () => view(confirmed ?? server),
      savePlanDraft: (c: { rows: PlanRowDto[] }) =>
        new Promise<{ targetBusinessDate: string; status: PlanView['status'] }>(
          (resolve) =>
            saves.push({
              rows: c.rows,
              release: () => {
                server = c.rows;
                resolve({
                  targetBusinessDate: 'T',
                  status: { status: 'draft', n: null },
                });
              },
            }),
        ),
      confirmPlan: async () => {
        confirms.push(server);
        confirmed = server;
        return { targetBusinessDate: 'T', n: 1, rows: server };
      },
    },
  };
}
const row = (target: string) => [{ item: 'support', target }];

describe('plan editor date, quantity and permission presentation', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each<Lang>(['zh', 'en', 'sr', 'es'])(
    'shows selected entries once, units, blank/zero and both business dates in %s',
    async (lang) => {
      vi.stubGlobal('localStorage', { getItem: () => lang });
      vi.stubGlobal('navigator', { languages: [] });
      const f = fakeApi([
        { item: 'support', target: '0' },
        { item: 'cable', target: '' },
      ]);
      const s = new PlanSession(
        f.api as never,
        'TEST-project',
        '2026-10-07',
        () => undefined,
      );
      await s.load();
      const day = {
        businessDate: '2026-10-06',
        items: ['support', 'cable', 'module'].map((key) => ({
          key,
          kind: 'work',
          active: true,
          label: `TEST-${key}`,
          unit: 'TEST-m',
        })),
        facts: { qty: { support: '0', cable: 'unknown' } },
      } as unknown as DayView;
      const render = (canWrite: boolean) =>
        renderToStaticMarkup(
          createElement(I18nProvider, {
            children: createElement(PlanEditor, {
              session: s,
              day,
              canWrite,
              onChanged: () => undefined,
            }),
          }),
        );
      const html = render(true);
      expect(html.match(/TEST-support/g)).toHaveLength(1);
      expect(html.match(/TEST-cable/g)).toHaveLength(1);
      expect(html).toContain('TEST-module');
      expect(html).toContain('TEST-m');
      expect(html).toMatch(/datetime="2026-10-07"/i);
      expect(html).toMatch(/datetime="2026-10-06"/i);
      expect(html).toContain(`${translate(lang, 'planned')} · 0`);
      expect(html).toContain(translate(lang, 'notFilled'));
      expect(html).toContain('unknown');
      expect(html).not.toContain('<select');
      const reader = render(false);
      expect(reader).not.toContain('TEST-module');
      expect(reader).not.toContain(translate(lang, 'confirmPlan'));
      expect(reader).toContain('disabled=""');
      expect(LOCALES[lang]).toBeTruthy();
    },
  );
});

describe('explicit target-day adoption of previous reference', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('offers explicit save but disables confirmation for an unadopted reference', async () => {
    vi.stubGlobal('localStorage', { getItem: () => 'en' });
    vi.stubGlobal('navigator', { languages: [] });
    const f = fakeApi(row('500'));
    const s = new PlanSession(
      f.api as never,
      'p',
      '2026-10-07',
      () => undefined,
    );
    await s.load();
    const day = {
      businessDate: '2026-10-06',
      items: [],
      facts: { qty: {} },
    } as unknown as DayView;
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        children: createElement(PlanEditor, {
          session: s,
          day,
          canWrite: true,
          onChanged: () => undefined,
        }),
      }),
    );
    const buttons =
      html.replaceAll('&#x27;', "'").match(/<button[^>]*>[^<]*<\/button>/g) ??
      [];
    const save = buttons.find((b) => b.includes(translate('en', 'save')));
    const confirm = buttons.find((b) =>
      b.includes(translate('en', 'confirmPlan')),
    );
    expect(save).toBeDefined();
    expect(save).not.toContain('disabled=');
    expect(confirm).toBeDefined();
    expect(confirm).toContain('disabled=""');
  });

  it('loading and leaving a reference do not save or confirm it', async () => {
    const f = fakeApi(row('500'));
    const s = new PlanSession(f.api as never, 'p', 'T', () => undefined);
    await s.load();
    expect(s.referenceOnly).toBe(true);
    await s.save();
    await expect(s.confirm()).rejects.toMatchObject({ code: 'PLAN_EMPTY' });
    expect(f.saves).toHaveLength(0);
    expect(f.confirms).toHaveLength(0);
    expect(s.rows).toEqual(row('500'));
    expect(s.hasOwnDraft).toBe(false);
  });

  it('explicitly saves unchanged reference rows to the target day before confirmation', async () => {
    let draft: PlanRowDto[] | null = null;
    const saves: PlanRowDto[][] = [];
    const confirms: PlanRowDto[][] = [];
    const reference = row('500');
    const api = {
      plan: async () => ({ ...view(draft ?? reference), draft }),
      savePlanDraft: async (c: {
        targetBusinessDate: string;
        rows: PlanRowDto[];
      }) => {
        expect(c.targetBusinessDate).toBe('T');
        saves.push(c.rows);
        draft = c.rows;
        return {
          targetBusinessDate: 'T',
          status: { status: 'draft' as const, n: null },
        };
      },
      confirmPlan: async () => {
        expect(draft).not.toBeNull();
        confirms.push(draft!);
        return { targetBusinessDate: 'T', n: 1, rows: draft! };
      },
    };
    const make = () => new PlanSession(api as never, 'p', 'T', () => undefined);
    const s = make();
    await s.load();
    await s.saveReferenceDraft();
    expect(saves).toEqual([row('500')]);
    expect(saves[0]).not.toBe(reference);
    expect(saves[0]?.[0]).not.toBe(reference[0]);
    expect(reference).toEqual(row('500'));
    expect(s.hasOwnDraft).toBe(true);
    expect(s.referenceOnly).toBe(false);
    await s.saveReferenceDraft();
    expect(saves).toHaveLength(1);
    const fresh = make();
    await fresh.load();
    expect(fresh.hasOwnDraft).toBe(true);
    await fresh.confirm();
    expect(confirms).toEqual([row('500')]);
  });

  it('does not adopt invalid or absent reference rows', async () => {
    for (const rows of [[], row('unknown')]) {
      const f = fakeApi(rows);
      const s = new PlanSession(f.api as never, 'p', 'T', () => undefined);
      await s.load();
      await s.saveReferenceDraft();
      expect(f.saves).toHaveLength(0);
      expect(s.hasOwnDraft).toBe(false);
    }
  });
});

describe('temporary plan quantity entry', () => {
  const owner = {};
  const context = (value = '', present = false) => ({
    owner,
    item: 'support',
    unit: 'TEST-m',
    value,
    present,
    locked: false,
  });

  it('open and cancel never adopt a blank row or write to the plan', async () => {
    const f = fakeApi([]);
    const s = new PlanSession(f.api as never, 'p', 'T', () => undefined);
    await s.load();
    const entry = new PlanQuantityEntry();
    entry.open({ ...context(), owner: s });
    entry.edit('250');
    entry.cancel();
    expect(entry.complete({ ...context(), owner: s })).toEqual({
      kind: 'dismiss',
    });
    expect(s.rows).toEqual([]);
    expect(s.dirty).toBe(false);
    expect(f.saves).toHaveLength(0);
  });

  it.each(['', '0', '000.120000', ' 2,500 '])(
    'completes supported raw target %j without normalizing it',
    (value) => {
      const entry = new PlanQuantityEntry();
      entry.open(context());
      entry.edit(value);
      expect(entry.complete(context())).toEqual({ kind: 'apply', value });
    },
  );

  it.each(['unknown', 'na', '-1', '1.1234567', '100000000000000', ' '])(
    'keeps unsupported target %j in the buffer rather than clearing or submitting it',
    (value) => {
      const entry = new PlanQuantityEntry();
      entry.open(context('12', true));
      entry.edit(value);
      expect(entry.complete(context('12', true))).toEqual({ kind: 'invalid' });
      expect(entry.value).toBe(value);
      entry.edit('13');
      expect(entry.complete(context('12', true))).toEqual({
        kind: 'apply',
        value: '13',
      });
    },
  );

  it.each([
    { owner: {} },
    { item: 'another-work' },
    { unit: 'TEST-ft' },
    { value: '20' },
    { present: false },
    { locked: true },
  ])('dismisses a stale or no longer writable entry: %j', (changed) => {
    const entry = new PlanQuantityEntry();
    entry.open(context('12', true));
    entry.edit('15');
    expect(entry.complete({ ...context('12', true), ...changed })).toEqual({
      kind: 'dismiss',
    });
    expect(entry.complete(context('12', true))).toEqual({ kind: 'dismiss' });
  });

  it('never opens in a locked scope', () => {
    const entry = new PlanQuantityEntry();
    expect(entry.open({ ...context(), locked: true })).toBe(false);
    entry.edit('0');
    expect(entry.complete(context())).toEqual({ kind: 'dismiss' });
  });
});

describe('plan session', () => {
  it('saves, refreshes into a new session, confirms and appends a revision without changing v1', async () => {
    let draft: PlanRowDto[] | null = null;
    const versions: PlanView['versions'] = [];
    const api = {
      plan: async (): Promise<PlanView> => ({
        targetBusinessDate: '2026-10-07',
        status: {
          status: draft ? 'draft' : versions.length ? 'confirmed' : 'none',
          n: versions.at(-1)?.n ?? null,
        },
        rows: structuredClone(draft ?? versions.at(-1)?.rows ?? []),
        draft: structuredClone(draft),
        versions: structuredClone(versions),
      }),
      savePlanDraft: async (command: { rows: PlanRowDto[] }) => {
        draft = structuredClone(command.rows);
        return {
          targetBusinessDate: '2026-10-07',
          status: { status: 'draft' as const, n: versions.at(-1)?.n ?? null },
        };
      },
      confirmPlan: async () => {
        if (!draft) throw new ApiError('PLAN_EMPTY', 409);
        const version = {
          n: versions.length + 1,
          rows: structuredClone(draft),
          at: '2026-10-06T22:00:00Z',
          by: 'TEST-person',
        };
        versions.push(version);
        draft = null;
        return { ...version, targetBusinessDate: '2026-10-07' };
      },
    };
    let key = 0;
    const session = () =>
      new PlanSession(
        api,
        'TEST-project',
        '2026-10-07',
        () => undefined,
        10000,
        () => `TEST-${++key}`,
      );
    const original = session();
    await original.load();
    original.edit(row('0'));
    await original.save();
    const refreshed = session();
    await refreshed.load();
    expect(refreshed.rows).toEqual(row('0'));
    expect(refreshed.dirty).toBe(false);
    await refreshed.confirm();
    expect(refreshed.plan?.status).toEqual({ status: 'confirmed', n: 1 });
    refreshed.edit(row('15'));
    await refreshed.save();
    expect(versions[0]?.rows).toEqual(row('0'));
    await refreshed.confirm();
    expect(refreshed.plan?.status).toEqual({ status: 'confirmed', n: 2 });
    expect(refreshed.plan?.versions.map((v) => v.rows)).toEqual([
      row('0'),
      row('15'),
    ]);
  });

  it('a definite save rejection retains selected raw targets for return and later acknowledgement', async () => {
    let rejects = true;
    let persisted: PlanRowDto[] = [];
    const api = {
      plan: async () => ({ ...view(persisted), draft: persisted }),
      savePlanDraft: async (command: { rows: PlanRowDto[] }) => {
        if (rejects) throw new ApiError('NUMBER_INVALID', 409);
        persisted = command.rows;
        return {
          targetBusinessDate: 'T',
          status: { status: 'draft' as const, n: null },
        };
      },
      confirmPlan: async () => {
        throw new Error('not used');
      },
    };
    const s = new PlanSession(
      api as never,
      'p',
      'T',
      () => undefined,
      10000,
      () => 'TEST-key',
    );
    await s.load();
    s.edit(row('000.120000'));
    await expect(s.save()).rejects.toBeInstanceOf(ApiError);
    await s.load();
    expect(s.rows).toEqual(row('000.120000'));
    expect(s.dirty).toBe(true);
    rejects = false;
    await s.save();
    expect(s.rows).toEqual(row('000.120000'));
    expect(s.dirty).toBe(false);
    expect(persisted).toEqual(row('000.120000'));
    expect(s.plan?.draft).toEqual(row('000.120000'));
  });

  it.each(['unknown', 'na'])(
    'unsupported target %s cannot save or confirm as blank/zero',
    async (value) => {
      const f = fakeApi([]);
      const s = new PlanSession(
        f.api as never,
        'p',
        'T',
        () => undefined,
        10000,
        () => 'TEST-key',
      );
      await s.load();
      s.edit(row(value));
      await s.save();
      await expect(s.confirm()).rejects.toMatchObject({
        code: 'NUMBER_INVALID',
      });
      expect(s.rows).toEqual(row(value));
      expect(f.saves).toHaveLength(0);
      expect(f.confirms).toHaveLength(0);
    },
  );

  it('writes run in order: an older save can never land after a newer one', async () => {
    const f = fakeApi(row('0'));
    const s = new PlanSession(
      f.api as never,
      'p',
      'T',
      () => undefined,
      0,
      () => 'k',
    );
    await s.load();
    s.edit(row('100'));
    const first = s.save();
    await tick();
    s.edit(row('200'));
    const second = s.save();
    await tick();
    expect(f.saves).toHaveLength(1); // the second waits for the first
    f.saves[0]!.release();
    await first;
    await tick();
    expect(f.saves[1]!.rows).toEqual(row('200'));
    f.saves[1]!.release();
    await second;
  });

  it('confirm refuses edits and confirms exactly the acknowledged rows', async () => {
    const f = fakeApi(row('0'));
    const s = new PlanSession(
      f.api as never,
      'p',
      'T',
      () => undefined,
      0,
      () => 'k',
    );
    await s.load();
    s.edit(row('100'));
    const confirming = s.confirm();
    await tick();
    expect(s.confirming).toBe(true);
    expect(s.edit([])).toBe(false); // remove-all during confirmation is refused
    f.saves[0]!.release();
    await confirming;
    expect(f.confirms).toEqual([row('100')]);
    expect(s.rows).toEqual(row('100'));
  });

  it('sessions for different target dates never share rows or writes', async () => {
    const b = fakeApi(row('0'));
    const c = fakeApi(row('900'));
    const sb = new PlanSession(
      b.api as never,
      'p',
      'B',
      () => undefined,
      0,
      () => 'k',
    );
    const sc = new PlanSession(
      c.api as never,
      'p',
      'C',
      () => undefined,
      0,
      () => 'k',
    );
    await Promise.all([sb.load(), sc.load()]);
    sb.edit(row('200'));
    const pending = sb.save();
    await tick();
    b.saves[0]!.release();
    await pending;
    expect(b.saves.map((x) => x.rows)).toEqual([row('200')]);
    expect(c.saves).toHaveLength(0);
    expect(sc.rows).toEqual(row('900'));
  });
});

describe('plan session: fenced reads', () => {
  it('a read started before an edit and save never replaces the saved rows', async () => {
    let releaseRead: (v: PlanView) => void = () => undefined;
    const saves: PlanRowDto[][] = [];
    const confirms: PlanRowDto[][] = [];
    let server = row('100');
    const api = {
      plan: () => new Promise<PlanView>((r) => (releaseRead = r)),
      savePlanDraft: async (c: { rows: PlanRowDto[] }) => {
        saves.push(c.rows);
        server = c.rows;
        return {
          targetBusinessDate: 'T',
          status: { status: 'draft' as const, n: null },
        };
      },
      confirmPlan: async () => {
        confirms.push(server);
        return { targetBusinessDate: 'T', n: 1, rows: server };
      },
    };
    const s = new PlanSession(
      api as never,
      'p',
      'T',
      () => undefined,
      0,
      () => 'k',
    );
    // first load completes normally
    const first = s.load();
    releaseRead(view(row('100')));
    await first;
    // a second (remount) read is held while the user edits and the edit is saved
    const stale = s.load();
    s.edit(row('200'));
    await s.save();
    releaseRead(view(row('100')));
    await stale;
    expect(s.rows).toEqual(row('200'));
    // confirming covers exactly what is displayed
    const confirming = s.confirm();
    await tick();
    releaseRead(view(row('200')));
    await confirming;
    expect(confirms).toEqual([row('200')]);
    expect(saves).toEqual([row('200')]);
  });
});
