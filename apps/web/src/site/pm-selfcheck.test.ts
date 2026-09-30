import {
  createElement,
  type FunctionComponent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  FieldDeviceDto,
  FieldSettingsDto,
  RosterDto,
} from '@mje/contracts';
import { ApiError, reportApi, type Project } from '../api.js';
import { I18nProvider } from '../i18n.js';
import { ProxySheet } from './CheckIns.js';
import { PmOwnedBar } from './OwnedBar.js';
import { ActionSheet, DevicesCard } from './Devices.js';
import { EntryCodeCard } from './SitePage.js';
import { SettingsCards } from './Settings.js';
import { saveSettings, SiteSessions, startProxy } from './site-sessions.js';

/*
 * #40 self-check (L5) and round 1 (P4 QR result in the reader bar, P5 proxy owned by its day) against the #36/#37/#39 rules, on every PM write surface: the PM proxy
 * sheet, the field settings card and the device sheet and
 * list. (1) An unsettled code reads as an unknown outcome, first send and Retry. (2) A refusal
 * the server makes before replaying (FORBIDDEN / READ_ONLY from the project-writer check,
 * LOGIN_REQUIRED from sign-in) after an unanswered attempt reads "may already have been
 * recorded"; answered at once, it keeps its own message. (3) One source for a first
 * send's and a Retry's outcome. (4) Owners outlive write access: a reader sees an
 * owned-actions bar with Retry / Give up.
 */

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
const FORBIDDEN_WORDING =
  /did not succeed|nothing was saved|not saved|No connection; your entry is kept/;
const UNKNOWN: Record<string, RegExp> = {
  NETWORK: /No answer was received \(no connection\)/,
  REQUEST_FAILED: /The server gave no clear answer/,
  RETRY: /The server was busy; the outcome is not confirmed/,
  RATE_LIMITED: /Too many attempts for now; the outcome is not confirmed/,
};
const STATUS: Record<string, number> = {
  NETWORK: 0,
  REQUEST_FAILED: 500,
  RETRY: 503,
  RATE_LIMITED: 429,
  FORBIDDEN: 403,
  READ_ONLY: 403,
  LOGIN_REQUIRED: 401,
};
const MAYBE: Record<string, RegExp> = {
  FORBIDDEN:
    /no longer have write access to this project\. The earlier send may already have been recorded/,
  READ_ONLY:
    /no longer have write access to this project\. The earlier send may already have been recorded/,
  LOGIN_REQUIRED:
    /sign-in expired\. The earlier send may already have been recorded/,
};
const OWN: Record<string, RegExp> = {
  FORBIDDEN: /Not permitted/,
  READ_ONLY: /Read-only access: only the project manager can change this/,
  LOGIN_REQUIRED: /Your sign-in has expired/,
};
const err = (code: string) => new ApiError(code, STATUS[code] ?? 409);

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
const device: FieldDeviceDto = {
  id: 'A',
  personId: 'pA',
  displayName: 'TEST A',
  state: 'PENDING',
  effectiveState: 'PENDING',
  endReason: null,
  version: 1,
  createdAt: '2026-10-01T08:00:00.000Z',
  confirmedAt: null,
  confirmedBy: null,
  lastSeenAt: '2026-10-01T08:00:00.000Z',
  expiresAt: '2027-03-30T08:00:00.000Z',
  memberUntil: null,
};
const settingsDto: FieldSettingsDto = {
  projectId: P,
  // TEST coordinates only.
  siteReference: { n: 1, lat: '1.000000', lon: '1.000000', radiusM: 500 },
  settings: { n: 1, selfieEnabled: false, pmProxyDays: 7 },
};

/** A PM api whose writes answer from a queue (then OK). */
function pmApi() {
  const plan: ApiError[] = [];
  const log: string[] = [];
  const write = async (c: unknown) => {
    log.push(JSON.stringify(c));
    const a = plan.shift();
    if (a) throw a;
    return {} as never;
  };
  return {
    plan,
    log,
    api: {
      entryCode: async () => ({ code: null, createdAt: null }),
      devices: async () => [device],
      fieldSettings: async () => settingsDto,
      roster: async () => roster,
      checkIns: async (_p: string, d: string) => ({
        projectId: P,
        businessDate: d,
        seqBoundary: null,
        summary: { present: 0, self: 0, proxy: 0, flagged: 0 },
        checkIns: [],
      }),
      pmProxy: write,
      setFieldSettings: write,
      setSiteReference: write,
      confirmDevice: write,
      rejectDevice: write,
      revokeDevice: write,
      rotateEntryCode: write,
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
/** The buttons of a component's own render (their text and onClick), plus its HTML. */
function buttonsOf(
  C: FunctionComponent<never>,
  props: object,
  provide: (el: ReactElement) => ReactElement = (el) => el,
) {
  const out: {
    text: string;
    onClick: (() => unknown) | undefined;
    disabled: boolean | undefined;
  }[] = [];
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
  b: { text: string; onClick: (() => unknown) | undefined }[],
  text: RegExp,
) => {
  const btn = b.find((x) => text.test(x.text));
  expect(btn, `button ${text}`).toBeDefined();
  await btn!.onClick?.();
  await tick();
};

/** People-page sessions over the same PM api. */
function pmSessions() {
  const a = pmApi();
  return { ...a, sessions: new SiteSessions(a.api as never, P) };
}

type Surface = 'proxy' | 'settings' | 'device';
/** Start the surface's command on fresh PM state; returns what renders it. */
async function surface(s: Surface, a: ReturnType<typeof pmApi>) {
  const sessions = new SiteSessions(a.api as never, P);
  await sessions.roster.load();
  await sessions.settings.load();
  await sessions.devices.session.load();
  const day = sessions.checkIns(DAY);
  await day.list.load();
  const command = {
    projectId: P,
    personId: 'w',
    businessDate: DAY,
    occurredAt: null,
    source: 'FOREMAN_REPORTED' as const,
    reason: 'TEST reason',
    actorFix: null,
  };
  const start = () => {
    if (s === 'proxy')
      return day.proxy.run(command, (_d, key) => {
        const body = { ...command, clientMutationId: key };
        return { key, send: () => a.api.pmProxy(body) };
      });
    if (s === 'settings')
      return saveSettings(
        sessions.settingsSave,
        a.api as never,
        P,
        sessions.settings.data!,
        { selfieEnabled: false, pmProxyDays: 5 },
      );
    return sessions.devices.run({ kind: 'confirm', device, code: '111111' });
  };
  const retry = () =>
    s === 'proxy'
      ? day.proxy.retry()
      : s === 'settings'
        ? sessions.settingsSave.retry()
        : sessions.devices.retry();
  const render = () => {
    if (s === 'proxy')
      return wrap(
        createElement(ProxySheet, {
          api: a.api as never,
          project,
          sessions,
          date: DAY,
          onClose: () => {},
        }),
      );
    if (s === 'settings')
      return wrap(
        createElement(SettingsCards, {
          api: a.api as never,
          project,
          sessions,
        }),
      );
    return wrap(
      createElement(
        'div',
        null,
        createElement(
          DevicesCard as FunctionComponent<Record<string, unknown>>,
          {
            api: a.api,
            project,
            sessions,
            commands: sessions.devices,
            session: sessions.devices.session,
          },
        ),
        createElement(ActionSheet, {
          action: { kind: 'confirm', device },
          commands: sessions.devices,
          onClose: () => {},
        }),
      ),
    );
  };
  return { sessions, start, retry, render };
}

const SURFACES: Surface[] = ['proxy', 'settings', 'device'];

describe('#40 self-check: unknown outcomes read as unknown on every PM write surface', () => {
  for (const code of ['NETWORK', 'REQUEST_FAILED', 'RETRY', 'RATE_LIMITED'])
    for (const attempt of ['first send', 'Retry'] as const)
      for (const s of SURFACES)
        it(`${s} · ${code} · ${attempt}`, async () => {
          const a = pmApi();
          const x = await surface(s, a);
          a.plan.push(err(code));
          await x.start();
          if (attempt === 'Retry') {
            a.plan.push(err(code));
            await x.retry();
          }
          const html = x.render();
          expect(html).toMatch(UNKNOWN[code]!);
          expect(html).not.toMatch(FORBIDDEN_WORDING);
          // The same key and body on every resend.
          expect(new Set(a.log).size).toBe(1);
        });
});

describe('#40 self-check: authority re-checked before the replay → "may already have been recorded"', () => {
  for (const code of ['FORBIDDEN', 'READ_ONLY', 'LOGIN_REQUIRED'])
    for (const s of SURFACES) {
      it(`${s} · NETWORK then Retry → ${code}: may already have been recorded`, async () => {
        const a = pmApi();
        const x = await surface(s, a);
        a.plan.push(err('NETWORK'));
        await x.start();
        a.plan.push(err(code));
        const r = await x.retry();
        expect(r).toMatchObject({ kind: 'rejected', code });
        // Rendered twice (a remount): the outcome comes from its owner, not the component.
        for (const html of [x.render(), x.render()]) {
          expect(html).toMatch(MAYBE[code]!);
          expect(html).not.toMatch(FORBIDDEN_WORDING);
        }
      });
      it(`${s} · ${code} on the first, answered send keeps its own message`, async () => {
        const a = pmApi();
        const x = await surface(s, a);
        a.plan.push(err(code));
        await x.start();
        const html = x.render();
        expect(html).toMatch(OWN[code]!);
        expect(html).not.toMatch(/may already have been recorded/);
      });
    }
});

describe('#40 self-check: a reader keeps the owned attempts (owners outlive write access)', () => {
  it('proxy, settings save and device action unresolved → the bar lists each with Retry / Give up', async () => {
    const a = pmApi();
    const sessions = new SiteSessions(a.api as never, P);
    await sessions.roster.load();
    await sessions.settings.load();
    await sessions.devices.session.load();
    const day = sessions.checkIns(DAY);
    await day.list.load();
    a.plan.push(err('NETWORK'), err('NETWORK'), err('NETWORK'));
    const command = {
      projectId: P,
      personId: 'w',
      businessDate: DAY,
      occurredAt: null,
      source: 'FOREMAN_REPORTED' as const,
      reason: 'TEST reason',
      actorFix: null,
    };
    await day.proxy.run(command, (_d, key) => {
      const body = { ...command, clientMutationId: key };
      return { key, send: () => a.api.pmProxy(body) };
    });
    await saveSettings(
      sessions.settingsSave,
      a.api as never,
      P,
      sessions.settings.data!,
      {
        selfieEnabled: false,
        pmProxyDays: 5,
      },
    );
    await sessions.devices.run({ kind: 'confirm', device, code: '111111' });
    // The bar the workspace shows a reader. At d493758 a reader saw nothing of these.
    const mod = (await import('./OwnedBar.js').catch(() => null)) as {
      PmOwnedBar?: FunctionComponent<Record<string, unknown>>;
    } | null;
    const owners = { site: sessions };
    const html = mod?.PmOwnedBar
      ? wrap(createElement(mod.PmOwnedBar, { owners }))
      : '';
    expect(html).toMatch(/Unresolved actions/);
    expect(html).toMatch(/PM check-in for TEST worker/);
    expect(html).toMatch(/Saving the field settings/);
    expect(html).toMatch(/Confirming the phone of TEST A/);
    expect(html.match(/>Retry</g)?.length).toBe(3);
    expect(html.match(/>Give up</g)?.length).toBe(3);
    expect(html).toMatch(UNKNOWN.NETWORK!);
    expect(html).not.toMatch(FORBIDDEN_WORDING);
  });
});

describe('#40 self-check: the QR code change (a PM write) uses the same mapping', () => {
  const rotate = (
    sessions: SiteSessions,
    api: { rotateEntryCode: (c: unknown) => Promise<never> },
  ) =>
    sessions.entry.act(() => {
      const c = { projectId: P, clientMutationId: 'k-rotate' };
      return { key: c.clientMutationId, send: () => api.rotateEntryCode(c) };
    });
  const card = (sessions: SiteSessions, api: unknown) =>
    wrap(
      createElement(EntryCodeCard, { sessions, project, api: api as never }),
    );
  for (const code of ['NETWORK', 'REQUEST_FAILED'])
    it(`unresolved after ${code}: unknown outcome`, async () => {
      const a = pmApi();
      const api = {
        ...a.api,
        rotateEntryCode: () => Promise.reject(err(code)),
      };
      const sessions = new SiteSessions(api as never, P);
      await sessions.entry.load();
      await rotate(sessions, api);
      const html = card(sessions, api);
      expect(html).toMatch(UNKNOWN[code]!);
      expect(html).not.toMatch(FORBIDDEN_WORDING);
    });
  it('NETWORK then Retry → READ_ONLY: may already have been recorded, shown outside the sheet', async () => {
    const answers = [err('NETWORK'), err('READ_ONLY')];
    const a = pmApi();
    const api = {
      ...a.api,
      rotateEntryCode: () => Promise.reject(answers.shift()),
    };
    const sessions = new SiteSessions(api as never, P);
    await sessions.entry.load();
    await rotate(sessions, api);
    await sessions.entry.retry();
    const html = card(sessions, api);
    expect(html).toMatch(MAYBE.READ_ONLY!);
  });
});

describe('#40 self-check: a PM refusal after a lost request (transport resend) is uncertain too', () => {
  it('the real report API: pmProxy lost once, resent, answered READ_ONLY → may already have been recorded', async () => {
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new TypeError('network');
      return new Response(JSON.stringify({ code: 'READ_ONLY' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const api = reportApi(async () => 'TEST-token');
      const a = pmApi();
      const sessions = new SiteSessions(a.api as never, P);
      await sessions.roster.load();
      const day = sessions.checkIns(DAY);
      await day.list.load();
      const command = {
        projectId: P,
        personId: 'w',
        businessDate: DAY,
        occurredAt: null,
        source: 'FOREMAN_REPORTED' as const,
        reason: 'TEST reason',
        actorFix: null,
      };
      await day.proxy.run(command, (_d, key) => {
        const body = { ...command, clientMutationId: key };
        return { key, send: () => api.pmProxy(body) };
      });
      expect(calls).toBe(2);
      const html = wrap(
        createElement(ProxySheet, {
          api: a.api as never,
          project,
          sessions,
          date: DAY,
          onClose: () => {},
        }),
      );
      expect(html).toMatch(MAYBE.READ_ONLY!);
    } finally {
      globalThis.fetch = real;
    }
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
    const owners = { site: pm.sessions };
    const before = buttonsOf(PmOwnedBar as FunctionComponent<never>, {
      owners,
    });
    expect(before.html).toMatch(/Changing the QR code/);
    await click(before.buttons, /^Retry$/);
    const after = wrap(createElement(PmOwnedBar, { owners: owners as never }));
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
    // What the sheet's Check in does.
    await startProxy(pm.sessions, pm.api as never, command as never);
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
        owners: { site: pm.sessions } as never,
      }),
    );
    expect(bar).toMatch(/PM check-in for TEST worker \(Thu 1 October\)/);
  });
});
