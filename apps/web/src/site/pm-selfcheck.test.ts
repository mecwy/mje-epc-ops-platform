import { createElement, type FunctionComponent } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  FieldDeviceDto,
  FieldSettingsDto,
  RosterDto,
} from '@mje/contracts';
import {
  ApiError,
  reportApi,
  type ForemanDayView,
  type Project,
} from '../api.js';
import { I18nProvider } from '../i18n.js';
import { AdoptFlow } from '../report/foreman-adopt.js';
import { ForemanLine, PmFieldContext } from '../report/ForemanLine.js';
import { ProxySheet } from './CheckIns.js';
import { ActionSheet, DevicesCard } from './Devices.js';
import { EntryCodeCard } from './SitePage.js';
import { SettingsCards } from './Settings.js';
import { saveSettings, SiteSessions } from './site-sessions.js';

/*
 * #40 self-check (L5) against the #36/#37/#39 rules, on every PM write surface: the PM proxy
 * sheet, the foreman-total adoption line, the field settings card and the device sheet and
 * list. (1) An unsettled code reads as an unknown outcome, first send and Retry. (2) A refusal
 * the server makes before replaying (FORBIDDEN / READ_ONLY from the project-writer check,
 * LOGIN_REQUIRED from sign-in) after an unanswered attempt reads "may already have been
 * recorded"; answered at once, it keeps its own message. FOREMAN_TOTAL_CHANGED is judged after
 * the replay (report-store adoptForeman), so it stays certain. (3) One source for a first
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
const wrap = (el: ReturnType<typeof createElement>) =>
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
const view = (value: string): ForemanDayView => ({
  rosterVersion: 1,
  expectedCrews: [{ crewId: 'c', code: 'A', name: 'TEST A', hasForeman: true }],
  revisions: [],
  items: {
    support: {
      status: 'COMPLETE',
      value,
      atLeast: null,
      crews: { c: { status: 'VALUE', qty: value, expected: true } },
    },
  },
  adoptions: [],
  basis: {
    rosterVersion: 1,
    expectedCrews: ['c'],
    revisions: [{ crewId: 'c', n: 1 }],
  },
  expectedCrewsChanged: null,
});

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
      checkIns: async () => ({
        projectId: P,
        businessDate: DAY,
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
      adoptForeman: write,
    },
  };
}

type Surface = 'proxy' | 'adopt' | 'settings' | 'device';
/** Start the surface's command on fresh PM state; returns what renders it. */
async function surface(s: Surface, a: ReturnType<typeof pmApi>) {
  const sessions = new SiteSessions(a.api as never, P);
  await sessions.roster.load();
  await sessions.settings.load();
  await sessions.devices.session.load();
  const day = sessions.checkIns(DAY);
  await day.list.load();
  const flow = new AdoptFlow(
    {
      api: a.api,
      projectId: P,
      businessDate: DAY,
      flush: async () => 'ok',
      current: () => ({ foreman: view('10'), version: 3 }),
      reload: async () => {},
    },
    () => {},
  );
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
    if (s === 'adopt')
      return flow.adopt('support', { basis: view('10').basis, value: '10' });
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
      : s === 'adopt'
        ? flow.retry()
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
    if (s === 'adopt')
      return wrap(
        createElement(
          PmFieldContext.Provider,
          {
            value: {
              foreman: view('10'),
              adopt: flow,
              canWrite: true,
              dayState: 'draft',
              timeZone: project.timezone,
              checkIns: null,
            },
          },
          createElement(ForemanLine, { itemKey: 'support' }),
        ),
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
  return { sessions, flow, start, retry, render };
}

const SURFACES: Surface[] = ['proxy', 'adopt', 'settings', 'device'];

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

  it('adopt · FOREMAN_TOTAL_CHANGED after an unanswered attempt stays certain (judged after the replay)', async () => {
    const a = pmApi();
    const x = await surface('adopt', a);
    a.plan.push(err('NETWORK'));
    await x.start();
    a.plan.push(err('FOREMAN_TOTAL_CHANGED'));
    await x.retry();
    const html = x.render();
    expect(html).toMatch(/you saw 10/i);
    expect(html).not.toMatch(/may already have been recorded/);
  });
});

describe('#40 self-check: a reader keeps the owned attempts (owners outlive write access)', () => {
  it('proxy, adoption, settings save and device action unresolved → the bar lists each with Retry / Give up', async () => {
    const a = pmApi();
    const sessions = new SiteSessions(a.api as never, P);
    await sessions.roster.load();
    await sessions.settings.load();
    await sessions.devices.session.load();
    const day = sessions.checkIns(DAY);
    await day.list.load();
    const flow = new AdoptFlow(
      {
        api: a.api,
        projectId: P,
        businessDate: DAY,
        flush: async () => 'ok',
        current: () => ({ foreman: view('10'), version: 3 }),
        reload: async () => {},
      },
      () => {},
    );
    a.plan.push(err('NETWORK'), err('NETWORK'), err('NETWORK'), err('NETWORK'));
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
    await flow.adopt('support', { basis: view('10').basis, value: '10' });
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
    const owners = { site: sessions, adoptDays: () => [[DAY, flow]] };
    const html = mod?.PmOwnedBar
      ? wrap(
          createElement(mod.PmOwnedBar, {
            owners,
            itemLabel: () => 'TEST support',
          }),
        )
      : '';
    expect(html).toMatch(/Unresolved actions/);
    expect(html).toMatch(/PM check-in for TEST worker/);
    expect(html).toMatch(/Using the foreman total: TEST support/);
    expect(html).toMatch(/Saving the field settings/);
    expect(html).toMatch(/Confirming the phone of TEST A/);
    expect(html.match(/>Retry</g)?.length).toBe(4);
    expect(html.match(/>Give up</g)?.length).toBe(4);
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
