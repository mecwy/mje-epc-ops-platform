import { createElement, Fragment, type FunctionComponent } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  CheckInResultDto,
  FieldMeDto,
  ForemanReportCommand,
  ForemanReportDto,
  ProxyCheckInCommand,
} from '@mje/contracts';
import { ApiError } from '../api.js';
import { I18nProvider } from '../i18n.js';
import { CrewCommands } from './crew-commands.js';
import * as Panel from './ForemanPanel.js';
import { ReportDays, reportDays, reportPayload } from './foreman-report.js';
import type { ForemanOwners } from './foreman-owners.js';
import { ProxyFlow } from './proxy-flow.js';
import { FieldSession } from './session.js';

/*
 * #39 review round 3 (L5). (1) Command owners live for the device session: the foreman role
 * lost and restored × the attempt running / unresolved / refused × remount, for crew confirm,
 * crew check-in and the quantity report. (2) One outcome mapping: every unsettled code × first
 * send / Retry × every surface reads as an unknown outcome, and no text ever says the command
 * failed or was not saved while its outcome is unknown or uncertain.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));
const wrap = (el: ReturnType<typeof createElement>) =>
  renderToString(createElement(I18nProvider, null, el));
const TZ = 'Europe/Belgrade';
const DAY = reportDays(TZ, new Date())[0];
const W1 = '11111111-1111-4111-8111-111111111111';
const W2 = '22222222-2222-4222-8222-222222222222';
const CREW = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FORBIDDEN =
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
};

const meWith = (foreman: boolean): FieldMeDto => ({
  device: {
    deviceId: 'fd',
    state: 'CONFIRMED',
    generation: 0,
    pendingUntil: null,
    expiresAt: '2027-01-01T00:00:00.000Z',
    memberUntil: null,
    tokenIssuedAt: '2026-10-01T00:00:00.000Z',
  },
  person: { id: 'f', displayName: 'TEST foreman' },
  project: { id: 'p', name: 'TEST', timezone: TZ },
  settings: { selfieEnabled: false },
  crew: null,
  foreman: foreman
    ? {
        crewId: CREW,
        crewName: 'TEST crew',
        members: [W1, W2].map((personId) => ({
          personId,
          displayName: personId === W1 ? 'TEST W1' : 'TEST W2',
          currentDeviceId: null,
          pendingDevices: 0,
        })),
      }
    : null,
});
const report = (n: number, qty: string): ForemanReportDto => ({
  crewId: CREW,
  crewName: 'TEST crew',
  businessDate: DAY,
  n,
  rows: [{ itemKey: 'support', qty }],
  note: '',
  occurredAt: null,
  receivedAt: null,
  items: [{ key: 'support', label: 'TEST support', unit: 'set' }],
});
const checkedIn = (): CheckInResultDto => ({
  checkInId: 'c',
  businessDate: DAY,
  kind: 'FOREMAN_PROXY',
  occurredAt: new Date().toISOString(),
  timePrecision: 'EXACT',
  flags: [],
  hasSelfie: false,
  afterSubmission: false,
});

type Answer = 'ok' | 'hold' | ApiError;
/** A queue of answers per route; `hold` waits until released (then answers the next one). */
function route<T>(ok: () => T) {
  const plan: Answer[] = [];
  const held: (() => void)[] = [];
  const log: string[] = [];
  const answer = async (body: unknown): Promise<T> => {
    log.push(JSON.stringify(body));
    let a = plan.shift() ?? 'ok';
    if (a === 'hold') {
      await new Promise<void>((r) => held.push(r));
      a = plan.shift() ?? 'ok';
    }
    if (a instanceof ApiError) throw a;
    return ok();
  };
  return { plan, held, log, answer };
}

/** The device page's owners, built the way foreman-owners.ts builds them. */
function device() {
  let me = meWith(true);
  let server = report(1, '10');
  const session = new FieldSession<FieldMeDto>(
    async () => me,
    () => {},
  );
  const crewRoute = route(() => ({}) as never);
  const proxyRoute = route(checkedIn);
  const reportRoute = route(() => ({}));
  const api = {
    confirmCrew: (c: unknown) => crewRoute.answer(c),
    rejectCrew: (c: unknown) => crewRoute.answer(c),
    proxyCheckIn: (_k: string, build: () => ProxyCheckInCommand) =>
      proxyRoute.answer(build()),
    report: async () => server,
    submitReport: (c: ForemanReportCommand) => reportRoute.answer(c),
  };
  let keys = 0;
  const owners: ForemanOwners = {
    crew: new CrewCommands(session, api as never, () => `c${++keys}`),
    proxy: new ProxyFlow({
      api: api as never,
      deviceId: 'fd',
      timeZone: TZ,
      storage: null,
      // TEST coordinates only.
      locate: async () => ({
        fix: {
          lat: '1.000000',
          lon: '1.000000',
          accuracyM: '10.00',
          fixAt: new Date().toISOString(),
        },
        reason: null,
      }),
      now: () => Date.now(),
      newKey: () => `p${++keys}`,
      onEnded: () => {},
      notify: () => {},
    }),
    reports: new ReportDays(
      api as never,
      () => {},
      () => {},
      undefined,
      () => `r${++keys}`,
    ),
  };
  return {
    api,
    session,
    owners,
    crewRoute,
    proxyRoute,
    reportRoute,
    setRole: async (foreman: boolean) => {
      me = meWith(foreman);
      await session.load();
    },
    setServer: (d: ForemanReportDto) => (server = d),
    me: () => me,
  };
}
type Device = ReturnType<typeof device>;
type Legacy = Record<string, unknown>;

/**
 * The foreman part of the device page for the current `me`. Where ForemanArea exists it is
 * rendered (the owners come from the device page). At 13091d4 it did not: the page rendered
 * CrewCard and ReportCard only while the role was present, each a fresh mount holding its own
 * owners, and nothing while the role was absent; that is rendered instead.
 */
function page(d: Device) {
  const Area = (Panel as Partial<typeof Panel>).ForemanArea;
  const me = d.me();
  if (Area)
    return wrap(createElement(Area, { me, owners: d.owners, tab: 'crew' }));
  const legacy: Legacy = {
    api: d.api,
    me,
    session: d.session,
    onEnded: () => {},
  };
  return wrap(
    me.foreman
      ? createElement(
          Fragment,
          null,
          createElement(
            Panel.CrewCard as unknown as FunctionComponent<Legacy>,
            legacy,
          ),
          createElement(
            Panel.ReportCard as unknown as FunctionComponent<Legacy>,
            legacy,
          ),
        )
      : createElement(Fragment),
  );
}
/** Start the surface's attempt; returns the pending promise. */
function start(d: Device, surface: 'confirm' | 'proxy' | 'report') {
  if (surface === 'confirm')
    return d.owners.crew.run({
      personId: W1,
      name: 'TEST W1',
      what: 'confirm',
      code: '111111',
    });
  if (surface === 'proxy') return d.owners.proxy.checkIn(W1, 'TEST W1');
  const day = d.owners.reports.get(DAY);
  return day.send(
    reportPayload(day.session.data!, [{ itemKey: 'support', qty: '12' }], ''),
  );
}
function retry(d: Device, surface: 'confirm' | 'proxy' | 'report') {
  if (surface === 'confirm') return d.owners.crew.retry();
  if (surface === 'proxy') return d.owners.proxy.retry();
  return d.owners.reports.get(DAY).retry();
}
const routeOf = (d: Device, s: 'confirm' | 'proxy' | 'report') =>
  s === 'confirm' ? d.crewRoute : s === 'proxy' ? d.proxyRoute : d.reportRoute;
const WHAT = {
  confirm: /Confirming the phone of TEST W1/,
  proxy: /Check-in for TEST W1/,
  report: /Quantities for/,
};

describe('#39 round 3 finding 1: owners live for the device session, not the foreman role', () => {
  for (const surface of ['confirm', 'proxy', 'report'] as const)
    for (const state of ['running', 'unresolved', 'refused'] as const)
      it(`${surface} · ${state} · role lost → restored · remount`, async () => {
        const d = device();
        await d.session.load();
        await d.owners.reports.get(DAY).session.load();
        const r = routeOf(d, surface);
        const refusal =
          surface === 'confirm'
            ? new ApiError('CHALLENGE_INVALID', 409)
            : surface === 'proxy'
              ? new ApiError('PROXY_NOT_ALLOWED', 409)
              : new ApiError('REVISION_CONFLICT', 409);
        if (state === 'running')
          r.plan.push('hold', new ApiError('NETWORK', 0));
        if (state === 'unresolved') r.plan.push(new ApiError('NETWORK', 0));
        if (state === 'refused') {
          if (surface === 'report') d.setServer(report(2, '15'));
          r.plan.push(refusal);
        }
        const attempt = start(d, surface);
        await tick();
        await tick();
        if (state !== 'running') await attempt;

        // The role is removed (`me.foreman` null): the owned attempt stays reachable.
        await d.setRole(false);
        for (const html of [page(d), page(d)]) {
          expect(html).toMatch(/Unresolved actions/);
          expect(html).toMatch(WHAT[surface]);
          if (state === 'running') expect(html).toMatch(/Saving…/);
          if (state === 'unresolved') {
            expect(html).toMatch(/>Retry</);
            expect(html).toMatch(/>Give up</);
            expect(html).toMatch(UNKNOWN.NETWORK!);
          }
          if (state === 'refused')
            expect(html).toMatch(
              surface === 'confirm'
                ? /Wrong or expired code/
                : surface === 'proxy'
                  ? /Only the crew foreman can check in others/
                  : /This report was just updated/,
            );
          expect(html).not.toMatch(FORBIDDEN);
        }
        if (state === 'running') {
          r.held.shift()!(); // the answer is lost while the role is gone
          await attempt;
        }

        // The role comes back: the same owners, the same attempt, its Retry works.
        await d.setRole(true);
        for (const html of [page(d), page(d)]) {
          if (state === 'refused') {
            if (surface === 'report') {
              expect(html).toContain('value="15"');
              expect(html).toMatch(/You had typed 12/);
            } else if (surface === 'proxy')
              expect(html).toMatch(/Only the crew foreman can check in others/);
            else expect(d.owners.crew.canStart).toBe(true);
          } else if (surface === 'confirm')
            expect(html).toMatch(
              /Confirming the phone of TEST W1 got no answer/,
            );
          else if (surface === 'proxy') {
            const row = html.slice(html.indexOf('TEST W1'));
            expect(row.slice(0, row.indexOf('</li>'))).toMatch(/>Retry</);
          } else {
            expect(html).toMatch(/No answer was received for this send/);
            expect(html).toMatch(/>12</);
          }
          // Only an established REVISION_CONFLICT (refused report) says "not saved".
          if (!(state === 'refused' && surface === 'report'))
            expect(html).not.toMatch(FORBIDDEN);
        }
        if (state !== 'refused') {
          r.plan.push('ok');
          const again = await retry(d, surface);
          if (again) expect(again.kind).toBe('ok');
          expect(r.log).toHaveLength(2);
          // The same key and body as the first send (never NOT_FOUND from an orphan); a
          // check-in's deviceSentAt is transport and refreshed (C43, not hashed).
          const hashed = (x: string) => {
            const o = JSON.parse(x) as Record<string, unknown>;
            delete o['deviceSentAt'];
            return JSON.stringify(o);
          };
          expect(hashed(r.log[1]!)).toBe(hashed(r.log[0]!));
        }
      });

  it('Give up from the bar while the role is gone releases the attempt', async () => {
    const d = device();
    await d.session.load();
    d.crewRoute.plan.push(new ApiError('NETWORK', 0));
    await start(d, 'confirm');
    await d.setRole(false);
    expect(page(d)).toMatch(/>Give up</);
    d.owners.crew.discard(); // what Give up calls
    await tick();
    await d.setRole(true);
    expect(d.owners.crew.canStart).toBe(true);
    expect(page(d)).not.toMatch(/got no answer/);
  });
});

describe('#39 round 3 finding 2: unknown outcomes read as unknown on every surface', () => {
  const surfaces = ['report', 'proxy', 'confirm', 'bar'] as const;
  for (const code of ['NETWORK', 'REQUEST_FAILED', 'RETRY', 'RATE_LIMITED'])
    for (const attempt of ['first send', 'Retry'] as const)
      for (const surface of surfaces)
        it(`${code} · ${attempt} · ${surface}`, async () => {
          const d = device();
          await d.session.load();
          await d.owners.reports.get(DAY).session.load();
          const on = surface === 'bar' ? 'confirm' : surface;
          const r = routeOf(d, on);
          const err = () => new ApiError(code, STATUS[code]!);
          r.plan.push(err());
          await start(d, on);
          if (attempt === 'Retry') {
            r.plan.push(err());
            await retry(d, on);
          }
          let html: string;
          if (surface === 'report')
            html = wrap(
              createElement(Panel.ReportDayBody, {
                report: d.owners.reports.get(DAY),
                timeZone: TZ,
              }),
            );
          else if (surface === 'proxy')
            html = wrap(
              createElement(Panel.CrewList, {
                me: d.me(),
                commands: d.owners.crew,
                flow: d.owners.proxy,
                confirming: null,
                onConfirming: () => {},
              }),
            );
          else if (surface === 'confirm')
            html = wrap(
              createElement(Panel.ConfirmSheet, {
                commands: d.owners.crew,
                member: d.me().foreman!.members[0]!,
                onClose: () => {},
              }),
            );
          else {
            await d.setRole(false);
            html = page(d);
          }
          expect(html).toMatch(UNKNOWN[code]!);
          expect(html).not.toMatch(FORBIDDEN);
        });

  it('the reviewer sequence: committed, answer lost, foreman moved, Retry NOT_FOREMAN, rereads fail → "may already have been recorded" and no "not saved"', async () => {
    const d = device();
    await d.session.load();
    const day = d.owners.reports.get(DAY);
    await day.session.load();
    d.reportRoute.plan.push(
      new ApiError('NETWORK', 0),
      new ApiError('NOT_FOREMAN', 403),
    );
    await start(d, 'report');
    d.api.report = async () => {
      throw new ApiError('NETWORK', 0);
    };
    await retry(d, 'report');
    const html = wrap(
      createElement(Panel.ReportDayBody, { report: day, timeZone: TZ }),
    );
    expect(html).toMatch(/may already have been recorded/);
    expect(html).not.toMatch(/You had typed/);
    expect(html).not.toMatch(FORBIDDEN);
  });

  for (const first of ['NETWORK', 'REQUEST_FAILED'] as const)
    it(`a REVISION_CONFLICT after an unanswered attempt (${first}) shows no "not saved" hint`, async () => {
      const d = device();
      await d.session.load();
      const day = d.owners.reports.get(DAY);
      await day.session.load();
      d.reportRoute.plan.push(new ApiError(first, STATUS[first]!));
      await start(d, 'report');
      d.setServer(report(2, '15'));
      d.reportRoute.plan.push(new ApiError('REVISION_CONFLICT', 409));
      const r = await retry(d, 'report');
      expect(r).toMatchObject({ kind: 'rejected', code: 'REVISION_CONFLICT' });
      await day.session.load();
      const html = wrap(
        createElement(Panel.ReportDayBody, { report: day, timeZone: TZ }),
      );
      expect(html).toContain('value="15"');
      expect(html).not.toMatch(/You had typed/);
      expect(html).not.toMatch(FORBIDDEN);
    });

  it('an established REVISION_CONFLICT (after 503 RETRY: nothing stored) still shows what was typed', async () => {
    const d = device();
    await d.session.load();
    const day = d.owners.reports.get(DAY);
    await day.session.load();
    d.reportRoute.plan.push(new ApiError('RETRY', 503));
    await start(d, 'report');
    d.setServer(report(2, '15'));
    d.reportRoute.plan.push(new ApiError('REVISION_CONFLICT', 409));
    await retry(d, 'report');
    await day.session.load();
    const html = wrap(
      createElement(Panel.ReportDayBody, { report: day, timeZone: TZ }),
    );
    expect(html).toMatch(/You had typed 12/);
  });
});
