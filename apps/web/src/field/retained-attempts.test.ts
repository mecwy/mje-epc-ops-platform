import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  FieldMeDto,
  ForemanReportCommand,
  ForemanReportDto,
} from '@mje/contracts';
import { ApiError } from '../api.js';
import { I18nProvider } from '../i18n.js';
import { shift } from '../report/format.js';
import { CrewCommands } from './crew-commands.js';
import { ForemanArea } from './ForemanPanel.js';
import { ReportDays, reportDays, reportPayload } from './foreman-report.js';
import type { ForemanOwners } from './foreman-owners.js';
import { ProxyFlow } from './proxy-flow.js';
import { FieldSession } from './session.js';

/*
 * #39 follow-up (Owner: merge #39, fix in a follow-up; Codex round 4). L5:
 * P2 — a report attempt for a day outside the selectable window (the site's today and
 * yesterday; site midnight moved it out) × running / unresolved / refused (first answer or
 * after Retry) × role kept / lost → restored × remount stays reachable in the report card with
 * its original key and body and Retry / Give up; the server decides (TOO_LATE is certain).
 * P3 — a certain crew-decision refusal × role kept (sheet closed) / lost → restored × remount
 * stays shown on the crew card until dismissed.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));
const wrap = (el: ReturnType<typeof createElement>) =>
  renderToString(createElement(I18nProvider, null, el));
const TZ = 'Europe/Belgrade';
const TODAY = reportDays(TZ, new Date())[0];
/** Two site days back: outside today/yesterday (as yesterday is after site midnight). */
const OLD = shift(TODAY, -2);
const W1 = '11111111-1111-4111-8111-111111111111';
const CREW = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FAILURE = /did not succeed|nothing was saved|not saved/;

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
        members: [
          {
            personId: W1,
            displayName: 'TEST W1',
            currentDeviceId: null,
            pendingDevices: 1,
          },
        ],
      }
    : null,
});
const report = (day: string): ForemanReportDto => ({
  crewId: CREW,
  crewName: 'TEST crew',
  businessDate: day,
  n: 1,
  rows: [{ itemKey: 'support', qty: '10' }],
  note: '',
  occurredAt: null,
  receivedAt: null,
  items: [{ key: 'support', label: 'TEST support', unit: 'set' }],
});

type Answer = 'ok' | 'hold' | ApiError;
function route() {
  const plan: Answer[] = [];
  const held: (() => void)[] = [];
  const log: string[] = [];
  const answer = async (body: unknown) => {
    log.push(JSON.stringify(body));
    let a = plan.shift() ?? 'ok';
    if (a === 'hold') {
      await new Promise<void>((r) => held.push(r));
      a = plan.shift() ?? 'ok';
    }
    if (a instanceof ApiError) throw a;
    return {} as never;
  };
  return { plan, held, log, answer };
}

function device() {
  let me = meWith(true);
  const session = new FieldSession<FieldMeDto>(
    async () => me,
    () => {},
  );
  const crewRoute = route();
  const reportRoute = route();
  const api = {
    confirmCrew: (c: unknown) => crewRoute.answer(c),
    rejectCrew: (c: unknown) => crewRoute.answer(c),
    proxyCheckIn: async () => ({}) as never,
    report: async (day: string) => report(day),
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
      locate: async () => ({ fix: null, reason: 'unsupported' }) as never,
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
  const page = (tab: 'crew' | 'report') =>
    wrap(createElement(ForemanArea, { me, owners, tab }));
  return {
    session,
    owners,
    crewRoute,
    reportRoute,
    page,
    setRole: async (foreman: boolean) => {
      me = meWith(foreman);
      await session.load();
    },
  };
}
type Device = ReturnType<typeof device>;

/** The report section of the page (the report card, when the role is present). */
const reportPart = (html: string) =>
  html.slice(html.lastIndexOf('<div hidden'));

/** Send 12 for OLD (a day that was yesterday before site midnight). */
async function sendOld(d: Device) {
  const day = d.owners.reports.get(OLD);
  await day.session.load();
  return day.send(
    reportPayload(day.session.data!, [{ itemKey: 'support', qty: '12' }], ''),
  );
}

describe('#39 follow-up P2: a report attempt outside today/yesterday stays reachable', () => {
  for (const role of ['kept', 'lost → restored'] as const)
    for (const state of [
      'running',
      'unresolved',
      'refused TOO_LATE',
      'Retry refused TOO_LATE',
    ] as const)
      it(`${state} · role ${role} · remount`, async () => {
        const d = device();
        await d.session.load();
        const r = d.reportRoute;
        if (state === 'running')
          r.plan.push('hold', new ApiError('NETWORK', 0));
        if (state === 'unresolved') r.plan.push(new ApiError('NETWORK', 0));
        if (state === 'refused TOO_LATE')
          r.plan.push(new ApiError('TOO_LATE', 409));
        if (state === 'Retry refused TOO_LATE')
          r.plan.push(
            new ApiError('NETWORK', 0),
            new ApiError('TOO_LATE', 409),
          );
        const attempt = sendOld(d);
        await tick();
        await tick();
        if (state !== 'running') await attempt;
        if (state === 'Retry refused TOO_LATE')
          await d.owners.reports.get(OLD).retry();
        if (role === 'lost → restored') {
          await d.setRole(false);
          await d.setRole(true);
        }
        for (const html of [d.page('report'), d.page('report')]) {
          const part = reportPart(html);
          // The retained day is named, outside the today/yesterday tabs.
          expect(part).toMatch(/Quantities for/);
          if (state === 'running') {
            expect(part).toMatch(/>12</);
            expect(part).toMatch(/Saving…/);
          } else if (state === 'unresolved') {
            expect(part).toMatch(/>12</);
            expect(part).toMatch(/>Retry</);
            expect(part).toMatch(/>Give up</);
            expect(part).toMatch(/No answer was received \(no connection\)/);
          } else {
            // TOO_LATE is decided after the replay: a certain refusal.
            expect(part).toMatch(/Too late to record from a phone/);
            expect(part).not.toMatch(/may already have been recorded/);
          }
          expect(part).not.toMatch(FAILURE);
        }
        if (state === 'running') {
          r.held.shift()!();
          await attempt;
          expect(reportPart(d.page('report'))).toMatch(/>Retry</);
        }
        if (state === 'running' || state === 'unresolved') {
          // Retry from the retained row: the original key and body; the server decides.
          r.plan.push('ok');
          expect((await d.owners.reports.get(OLD).retry()).kind).toBe('ok');
          expect(r.log).toHaveLength(2);
          expect(r.log[1]).toBe(r.log[0]);
          expect(reportPart(d.page('report'))).not.toMatch(/Quantities for/);
        } else {
          // Dismissed by the user: gone, nothing sent.
          const sent = r.log.length;
          // Optional call: at 27f13c2 there was no way to dismiss (the next check fails there).
          (
            d.owners.reports.get(OLD).sends as { clearRefusal?: () => void }
          ).clearRefusal?.();
          expect(reportPart(d.page('report'))).not.toMatch(/Quantities for/);
          expect(r.log).toHaveLength(sent);
        }
      });

  it('Give up from the retained row releases the attempt (it may still have been stored)', async () => {
    const d = device();
    await d.session.load();
    d.reportRoute.plan.push(new ApiError('NETWORK', 0));
    await sendOld(d);
    await d.setRole(false);
    await d.setRole(true);
    expect(reportPart(d.page('report'))).toMatch(/>Give up</);
    d.owners.reports.get(OLD).discard(); // what Give up calls
    await tick();
    expect(reportPart(d.page('report'))).not.toMatch(/Quantities for/);
    expect(d.owners.reports.owned()).toHaveLength(0);
  });
});

describe('#39 follow-up P3: a certain crew-decision refusal stays shown after the role returns', () => {
  for (const role of ['kept (sheet closed)', 'lost → restored'] as const)
    for (const certainty of ['certain', 'after an unanswered attempt'] as const)
      it(`${certainty} · role ${role} · remount`, async () => {
        const d = device();
        await d.session.load();
        if (certainty === 'certain')
          d.crewRoute.plan.push(new ApiError('CHALLENGE_INVALID', 409));
        else
          d.crewRoute.plan.push(
            new ApiError('NETWORK', 0),
            new ApiError('NOT_FOREMAN', 403),
          );
        await d.owners.crew.run({
          personId: W1,
          name: 'TEST W1',
          what: 'confirm',
          code: '111111',
        });
        if (certainty !== 'certain') await d.owners.crew.retry();
        if (role === 'lost → restored') {
          await d.setRole(false);
          await d.setRole(true);
        }
        for (const html of [d.page('crew'), d.page('crew')]) {
          expect(html).toContain('TEST W1</b>:');
          expect(html).toMatch(
            certainty === 'certain'
              ? /Wrong or expired code/
              : /may already have been recorded/,
          );
        }
        // What the Close button calls (absent at 27f13c2: the next check fails there).
        (d.owners.crew as { clearRefusal?: () => void }).clearRefusal?.();
        expect(d.page('crew')).not.toContain('TEST W1</b>:');
        expect(d.owners.crew.canStart).toBe(true);
      });
});
