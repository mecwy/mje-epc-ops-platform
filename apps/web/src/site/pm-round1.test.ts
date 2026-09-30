import {
  createElement,
  type FunctionComponent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  DayFactsDto,
  FieldSettingsDto,
  ForemanAdoptCommand,
  RosterDto,
  SaveFactsCommand,
} from '@mje/contracts';
import { ApiError, type ForemanDayView, type Project } from '../api.js';
import { I18nProvider } from '../i18n.js';
import { DraftSession } from '../report/draft.js';
import { AdoptFlow } from '../report/foreman-adopt.js';
import {
  ForemanLine,
  PmFieldContext,
  type PmField,
} from '../report/ForemanLine.js';
import { setFact } from '../report/model.js';
import { ProxySheet } from './CheckIns.js';
import { PmOwnedBar } from './OwnedBar.js';
import * as Sessions from './site-sessions.js';
import { SiteSessions } from './site-sessions.js';

/*
 * #40 Codex round 1 (L5): orderings with delayed writes and reads and changing totals, driving
 * the real handlers. Buttons are taken from the real components' rendered element trees (the
 * very onClick functions a tap calls), never re-implemented.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));
const P = '11111111-1111-4111-8111-111111111111';
const DAY = '2026-10-02';
const project: Project = {
  id: P,
  name: 'TEST',
  code: 'TEST',
  timezone: 'Europe/Belgrade',
  access: 'write',
};
const wrap = (el: ReactNode) =>
  renderToString(createElement(I18nProvider, null, el));

/** The buttons of a component's own render (their text and onClick), plus its HTML. */
function buttonsOf(
  C: FunctionComponent<never>,
  props: object,
  provide: (el: ReactElement) => ReactElement = (el) => el,
) {
  const out: { text: string; onClick?: () => unknown; disabled?: boolean }[] =
    [];
  const textOf = (n: unknown): string =>
    typeof n === 'string' || typeof n === 'number'
      ? String(n)
      : Array.isArray(n)
        ? n.map(textOf).join('')
        : n && typeof n === 'object' && 'props' in n
          ? textOf((n as { props: { children?: unknown } }).props.children)
          : '';
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object' || !('props' in n)) return;
    const el = n as { type: unknown; props: Record<string, unknown> };
    if (el.type === 'button')
      out.push({
        text: textOf(el.props.children),
        onClick: el.props.onClick as () => unknown,
        disabled: el.props.disabled as boolean | undefined,
      });
    walk(el.props.children);
  };
  // Called inside a render, so the component's hooks run as in the page.
  const Capture = () => {
    const tree = (C as unknown as (p: object) => ReactElement)(props);
    walk(tree);
    return tree;
  };
  const html = wrap(provide(createElement(Capture)));
  return { html, buttons: out };
}
const click = async (
  b: { text: string; onClick?: () => unknown }[],
  text: RegExp,
) => {
  const btn = b.find((x) => text.test(x.text));
  expect(btn, `button ${text}`).toBeDefined();
  await btn!.onClick?.();
  await tick();
};

const view = (
  value: string | null,
  status: 'COMPLETE' | 'PARTIAL' = 'COMPLETE',
  crews = true,
): ForemanDayView => ({
  rosterVersion: 1,
  expectedCrews: crews
    ? [{ crewId: 'c', code: 'A', name: 'TEST A', hasForeman: true }]
    : [],
  revisions: [],
  items: crews
    ? {
        support: {
          status,
          value,
          atLeast: null,
          crews: { c: { status: 'VALUE', qty: value, expected: true } },
        },
      }
    : {},
  adoptions: [],
  basis: {
    rosterVersion: 1,
    expectedCrews: crews ? ['c'] : [],
    revisions: [{ crewId: 'c', n: 1 }],
  },
  expectedCrewsChanged: null,
});

const blank = (): DayFactsDto => ({
  weather: '',
  temperature: '',
  qty: {},
  cumulative: {},
  narrative: { construction: '', quality: '', safety: '' },
  people: {},
  presence: {},
  machinery: {},
  materials: {},
  milestones: {},
  noWork: null,
  updated: {},
});

type Gate = { hold: boolean; waiting: (() => void)[] };
const gate = (): Gate => ({ hold: false, waiting: [] });
const pass = async (g: Gate) => {
  if (g.hold) await new Promise<void>((r) => g.waiting.push(r));
};
const open = (g: Gate) => {
  g.hold = false;
  g.waiting.splice(0).forEach((r) => r());
};

/**
 * A fake report server with one day: saves and adoptions check the version and bump it; an
 * adoption sets the item's quantity. Saves, adoptions and reads can be held (delayed).
 */
function dayServer() {
  let version = 1;
  let facts = blank();
  const save = gate();
  const adopt = gate();
  const read = gate();
  const adoptPlan: (ApiError | 'lost')[] = [];
  const adoptLog: string[] = [];
  let reads = 0;
  return {
    save,
    adopt,
    read,
    adoptPlan,
    adoptLog,
    reads: () => reads,
    facts: () => facts,
    version: () => version,
    saveFacts: async (c: SaveFactsCommand) => {
      await pass(save);
      if (c.expectedVersion !== version)
        throw new ApiError('VERSION_CONFLICT', 409);
      facts = c.facts;
      version++;
      return { businessDate: DAY, version, state: 'draft' } as never;
    },
    adoptForeman: async (c: ForemanAdoptCommand) => {
      adoptLog.push(JSON.stringify(c));
      await pass(adopt);
      const a = adoptPlan.shift();
      if (a instanceof ApiError) throw a;
      if (c.expectedVersion !== version) {
        if (a === 'lost') throw new ApiError('NETWORK', 0);
        throw new ApiError('VERSION_CONFLICT', 409);
      }
      facts = { ...facts, qty: { ...facts.qty, [c.item]: '10' } };
      version++;
      if (a === 'lost') throw new ApiError('NETWORK', 0);
      return {};
    },
    readDay: async () => {
      reads++;
      await pass(read);
      return { version, facts };
    },
  };
}

/**
 * The day as the workspace drives it: a DraftSession (the real one), the typing path of
 * useDay (`edit` refused while the day is held or busy), its autosave (flush; a conflict
 * reloads, as useDay's settleAfter does), and the hold / release useDay gives the adoption.
 */
function workspaceDay(sv: ReturnType<typeof dayServer>) {
  const s = new DraftSession(P, DAY, 0, blank(), sv.saveFacts, () => {});
  let busy = false;
  let conflicts = 0;
  const reload = async (replace: boolean) => {
    const g = s.editGeneration;
    const d = await sv.readDay();
    if (replace) s.reset(d.version, d.facts);
    else s.adopt(d, g);
  };
  const autosave = async () => {
    const o = await s.flush();
    if (o === 'conflict') {
      conflicts++;
      await reload(true);
    }
    return o;
  };
  const held = s as unknown as {
    hold?: () => Promise<string>;
    release?: () => void;
  };
  return {
    s,
    conflicts: () => conflicts,
    type: (workers: string) =>
      busy ? false : s.edit(setFact(s.facts, 'people.workers', workers)),
    autosave,
    ctx: {
      api: { adoptForeman: sv.adoptForeman },
      projectId: P,
      businessDate: DAY,
      current: () => ({ foreman: view('10'), version: s.version }),
      // useDay.hold / release (this change) …
      hold: async () => {
        busy = true;
        const o = held.hold ? await held.hold() : await s.settle();
        if (o !== 'ok') busy = false;
        return o;
      },
      release: async () => {
        try {
          await reload(true);
        } finally {
          held.release?.();
          busy = false;
        }
      },
      // … and useDay.flush / reload, which the adoption called before it.
      flush: () => autosave(),
      reload: () => reload(false),
    },
  };
}

describe("#40 round 1 P1: an adoption and the day's typing are one lifecycle (no typed value lost)", () => {
  const cases = [
    { stage: 'while the typed facts are being saved', outcome: 'ok' },
    { stage: 'while the adoption is in flight', outcome: 'ok' },
    {
      stage: 'while the adoption is in flight',
      outcome: 'FOREMAN_TOTAL_CHANGED',
    },
    { stage: 'while the adoption is unresolved', outcome: 'retry ok' },
    { stage: 'while the adoption is unresolved', outcome: 'give up' },
    { stage: 'while the day is read again', outcome: 'ok' },
  ] as const;
  for (const c of cases)
    it(`typed 7 ${c.stage} · ${c.outcome}`, async () => {
      const sv = dayServer();
      const day = workspaceDay(sv);
      day.s.reset(sv.version(), sv.facts());
      expect(day.type('5')).toBe(true); // typed before "Use 10", not yet saved
      const flow = new AdoptFlow(day.ctx as never, () => {});
      if (c.stage === 'while the typed facts are being saved')
        sv.save.hold = true;
      if (c.stage === 'while the adoption is in flight') sv.adopt.hold = true;
      if (c.stage === 'while the day is read again') sv.read.hold = true;
      if (c.outcome === 'FOREMAN_TOTAL_CHANGED')
        sv.adoptPlan.push(new ApiError('FOREMAN_TOTAL_CHANGED', 409));
      if (c.stage === 'while the adoption is unresolved')
        sv.adoptPlan.push('lost');
      const use = flow.adopt('support', {
        basis: view('10').basis,
        value: '10',
      });
      await tick();
      await tick();
      if (c.stage === 'while the adoption is unresolved') await use;
      // The PM types 7 at this stage; a stashed draft (sign-in recovery, reconcileDraft) is
      // applied to the session directly at the same moment.
      const accepted = day.type('7');
      const restored = day.s.edit(setFact(day.s.facts, 'people.helpers', '3'));
      // The stage ends; the adoption finishes; autosave runs as the page would.
      open(sv.save);
      open(sv.adopt);
      open(sv.read);
      if (c.stage !== 'while the adoption is unresolved') await use;
      else if (c.outcome === 'retry ok') await flow.retry();
      else await flow.discard();
      await tick();
      await day.autosave();
      // Never lost silently: an accepted 7 reaches the server. It must not be accepted while
      // the day is held; afterwards typing works again and is saved.
      if (accepted) expect(sv.facts().people.workers).toBe('7');
      if (restored) expect(sv.facts().people.helpers).toBe('3');
      expect(accepted).toBe(false);
      expect(restored).toBe(false);
      expect(day.conflicts()).toBe(0);
      expect(sv.facts().people.workers).toBe('5');
      if (c.outcome === 'ok' || c.outcome === 'retry ok')
        expect(sv.facts().qty.support).toBe('10');
      expect(day.type('7')).toBe(true);
      await day.autosave();
      expect(sv.facts().people.workers).toBe('7');
    });
});

function pmField(flow: AdoptFlow, foreman: ForemanDayView): PmField {
  return {
    foreman,
    adopt: flow,
    canWrite: true,
    dayState: 'draft',
    timeZone: project.timezone,
    checkIns: null,
  };
}

describe('#40 round 1 P2: an unresolved adoption is retried whatever the live total is now', () => {
  for (const now of ['PARTIAL (no value)', 'expected crews gone'] as const)
    it(`live total ${now}: the owned payload is shown and Retry resends it`, async () => {
      const sv = dayServer();
      const day = workspaceDay(sv);
      day.s.reset(sv.version(), sv.facts());
      const flow = new AdoptFlow(day.ctx as never, () => {});
      sv.adoptPlan.push('lost');
      await flow.adopt('support', { basis: view('10').basis, value: '10' });
      const live =
        now === 'PARTIAL (no value)'
          ? view(null, 'PARTIAL')
          : view(null, 'PARTIAL', false);
      const { html, buttons } = buttonsOf(
        ForemanLine as FunctionComponent<never>,
        { itemKey: 'support' },
        (el) =>
          createElement(
            PmFieldContext.Provider,
            { value: pmField(flow, live) },
            el,
          ),
      );
      expect(html).toMatch(/Using 10 got no answer/);
      await click(buttons, /^Retry$/);
      await tick();
      expect(sv.adoptLog).toHaveLength(2);
      expect(sv.adoptLog[1]).toBe(sv.adoptLog[0]);
    });
});

/** People-page sessions over a PM api whose writes answer from a queue. */
function pmSessions() {
  const plan: ApiError[] = [];
  const log: string[] = [];
  const roster: RosterDto = {
    projectId: P,
    rosterVersion: 1,
    crews: [],
    assignments: [
      {
        id: 'a',
        crewId: 'c',
        personId: 'w',
        displayName: 'TEST worker',
        role: 'MEMBER',
        validFrom: '2026-09-01T00:00:00.000Z',
        validUntil: null,
      },
    ],
  };
  const settings: FieldSettingsDto = {
    projectId: P,
    // TEST coordinates only.
    siteReference: { n: 1, lat: '1.000000', lon: '1.000000', radiusM: 500 },
    settings: { n: 1, selfieEnabled: false, pmProxyDays: 7 },
  };
  const write = async (c: unknown) => {
    log.push(JSON.stringify(c));
    const a = plan.shift();
    if (a) throw a;
    return {} as never;
  };
  const api = {
    entryCode: async () => ({ code: null, createdAt: null }),
    devices: async () => [],
    fieldSettings: async () => settings,
    roster: async () => roster,
    checkIns: async (_p: string, d: string) => ({
      projectId: P,
      businessDate: d,
      seqBoundary: null,
      summary: { present: 0, self: 0, proxy: 0, flagged: 0 },
      checkIns: [],
    }),
    pmProxy: write,
    rotateEntryCode: write,
  };
  const sessions = new SiteSessions(api as never, P);
  return { sessions, api, plan, log };
}

describe('#40 round 1 P3: the reader bar settles an adoption through the flow', () => {
  for (const answer of ['FOREMAN_TOTAL_CHANGED', 'give up'] as const)
    it(`bar Retry → ${answer}: the flow's own settlement (day read again, "you saw X")`, async () => {
      const sv = dayServer();
      const day = workspaceDay(sv);
      day.s.reset(sv.version(), sv.facts());
      const flow = new AdoptFlow(day.ctx as never, () => {});
      sv.adoptPlan.push('lost');
      await flow.adopt('support', { basis: view('10').basis, value: '10' });
      const pm = pmSessions();
      const owners = { site: pm.sessions, adoptDays: () => [[DAY, flow]] };
      const { buttons } = buttonsOf(PmOwnedBar as FunctionComponent<never>, {
        owners,
        itemLabel: () => 'TEST support',
      });
      const readsBefore = sv.reads();
      if (answer === 'FOREMAN_TOTAL_CHANGED') {
        sv.adoptPlan.push(new ApiError('FOREMAN_TOTAL_CHANGED', 409));
        await click(buttons, /^Retry$/);
        expect(flow.changed.support).toBe('10');
      } else await click(buttons, /^Give up$/);
      await tick();
      // The day was read again by the flow's settlement, and the adoption is released.
      expect(sv.reads()).toBeGreaterThan(readsBefore);
      expect(flow.owned.current).toBeNull();
      // Back in the writer view: "you saw 10, now …" (after a change) or nothing owned.
      const html = wrap(
        createElement(
          PmFieldContext.Provider,
          { value: pmField(flow, view('12')) },
          createElement(ForemanLine, { itemKey: 'support' }),
        ),
      );
      if (answer === 'FOREMAN_TOTAL_CHANGED')
        expect(html).toMatch(/you saw 10/i);
      expect(html).not.toMatch(/got no answer/);
    });
});

describe('#40 round 1 P4: a reader keeps the QR change result', () => {
  it('unanswered, then Retry refused READ_ONLY → the bar keeps a row: may already have been recorded', async () => {
    const pm = pmSessions();
    await pm.sessions.entry.load();
    pm.plan.push(new ApiError('NETWORK', 0), new ApiError('READ_ONLY', 403));
    await pm.sessions.entry.act(() => {
      const c = { projectId: P, clientMutationId: 'k-rotate' };
      return { key: c.clientMutationId, send: () => pm.api.rotateEntryCode(c) };
    });
    const owners = { site: pm.sessions, adoptDays: () => [] };
    const before = buttonsOf(PmOwnedBar as FunctionComponent<never>, {
      owners,
      itemLabel: () => '',
    });
    expect(before.html).toMatch(/Changing the QR code/);
    await click(before.buttons, /^Retry$/);
    const after = wrap(
      createElement(PmOwnedBar, {
        owners: owners as never,
        itemLabel: () => '',
      }),
    );
    expect(after).toMatch(/Changing the QR code/);
    expect(after).toMatch(
      /no longer have write access to this project\. The earlier send may already have been recorded/,
    );
  });
});

describe('#40 round 1 P5: a backdated PM proxy is owned by the day it is for', () => {
  it('sent from 2 October for 1 October, answer lost → opening 1 October shows it (no new form), Retry resends it', async () => {
    const pm = pmSessions();
    await pm.sessions.roster.load();
    await pm.sessions.settings.load();
    const command = {
      projectId: P,
      personId: 'w',
      businessDate: '2026-10-01',
      occurredAt: null,
      source: 'FOREMAN_REPORTED' as const,
      reason: 'TEST reason',
      actorFix: null,
    };
    pm.plan.push(new ApiError('NETWORK', 0));
    // What the sheet's Check in does (startProxy). At d/de15032 the sheet ran the command on
    // the owner of the page's date (2 October), as below.
    const start =
      (Sessions as Partial<typeof Sessions>).startProxy ??
      ((s: SiteSessions, api: typeof pm.api, c: typeof command) =>
        s.checkIns(DAY).proxy.run(c as never, (_d, key) => {
          const body = { ...c, clientMutationId: key };
          return { key, send: () => api.pmProxy(body) };
        }));
    await start(pm.sessions, pm.api as never, command as never);
    for (const date of ['2026-10-01', DAY]) {
      const html = wrap(
        createElement(ProxySheet, {
          api: pm.api as never,
          project,
          sessions: pm.sessions,
          date,
          onClose: () => {},
        }),
      );
      expect(html).not.toMatch(/<select/);
      expect(html).toContain('TEST worker');
      expect(html).toMatch(/Give up/);
    }
    // The bar names the day it is for.
    const bar = wrap(
      createElement(PmOwnedBar, {
        owners: { site: pm.sessions, adoptDays: () => [] } as never,
        itemLabel: () => '',
      }),
    );
    expect(bar).toMatch(/PM check-in for TEST worker \(Thu 1 October\)/);
  });
});
