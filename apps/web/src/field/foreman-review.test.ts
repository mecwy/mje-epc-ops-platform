import { createElement } from 'react';
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
import type { DeviceRecord } from './device-store.js';
import { deviceView } from './flow.js';
import { CrewList, ReportDayBody } from './ForemanPanel.js';
import { ReportDay, reportPayload } from './foreman-report.js';
import { ProxyFlow } from './proxy-flow.js';
import { FieldSession } from './session.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const wrap = (el: ReturnType<typeof createElement>) =>
  renderToString(createElement(I18nProvider, null, el));
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DAY = '2026-10-02';
const TZ = 'Europe/Belgrade';

type Mode = 'ok' | 'lost' | 'retry' | 'hold' | 'hold-lost';
/**
 * A fake report server with the A6c semantics: a send for a crew the foreman does not lead
 * now is refused; a stale revision gets REVISION_CONFLICT; a key's first answer is stored and
 * a same-key resend replays it only when its body is identical (else IDEMPOTENCY_KEY_REUSED).
 * RETRY (503) commits nothing. Reads can fail or be held. Every request is logged.
 */
function reportServer() {
  let crew = A;
  const rev: Record<string, { n: number; qty: string }> = {
    [A]: { n: 1, qty: '10' },
    [B]: { n: 1, qty: '30' },
  };
  let readsFail = false;
  let holdReads = false;
  const readHolds: (() => void)[] = [];
  const held: (() => void)[] = [];
  const plan: Mode[] = [];
  const log: ForemanReportCommand[] = [];
  const stored = new Map<string, { body: string; code: string | null }>();
  const dto = (): ForemanReportDto => ({
    crewId: crew,
    crewName: crew === A ? 'TEST crew A' : 'TEST crew B',
    businessDate: DAY,
    n: rev[crew]!.n,
    rows: [{ itemKey: 'support', qty: rev[crew]!.qty }],
    note: '',
    occurredAt: null,
    receivedAt: null,
    items: [{ key: 'support', label: 'TEST support', unit: 'set' }],
  });
  const api = {
    report: async () => {
      if (holdReads) await new Promise<void>((r) => readHolds.push(r));
      if (readsFail) throw new ApiError('NETWORK', 0);
      return dto();
    },
    submitReport: async (c: ForemanReportCommand) => {
      log.push(c);
      const mode = plan.shift() ?? 'ok';
      if (mode === 'retry') throw new ApiError('RETRY', 503);
      const body = JSON.stringify(c);
      const prior = stored.get(c.clientMutationId);
      let code: string | null;
      if (prior) {
        if (prior.body !== body)
          throw new ApiError('IDEMPOTENCY_KEY_REUSED', 409);
        code = prior.code;
      } else {
        if (c.crewId !== crew) code = 'NOT_FOREMAN';
        else if (c.expectedRevision !== rev[c.crewId]!.n)
          code = 'REVISION_CONFLICT';
        else {
          rev[c.crewId] = {
            n: rev[c.crewId]!.n + 1,
            qty: c.rows[0]!.qty,
          };
          code = null;
        }
        stored.set(c.clientMutationId, { body, code });
      }
      if (mode === 'hold' || mode === 'hold-lost')
        await new Promise<void>((r) => held.push(r));
      if (mode === 'lost' || mode === 'hold-lost')
        throw new ApiError('NETWORK', 0);
      if (code) throw new ApiError(code, 409);
      return {};
    },
  };
  return {
    api,
    log,
    plan,
    held,
    readHolds,
    rev,
    moveTo: (c: string) => (crew = c),
    /** Another send (for example from the foreman's other visit) stores a new revision. */
    other: (qty: string) => (rev[crew] = { n: rev[crew]!.n + 1, qty }),
    failReads: (v: boolean) => (readsFail = v),
    holdReads: (v: boolean) => (holdReads = v),
  };
}
function rig() {
  const sv = reportServer();
  let clock = Date.parse('2026-10-02T08:00:00.000Z');
  let keys = 0;
  const ended: string[] = [];
  const day = new ReportDay(
    sv.api,
    DAY,
    () => {},
    (c) => ended.push(c),
    () => new Date(clock),
    () => `k${++keys}`,
  );
  const body = () =>
    wrap(createElement(ReportDayBody, { report: day, timeZone: TZ }));
  return {
    sv,
    day,
    ended,
    body,
    advance: (ms: number) => (clock += ms),
    typed: (qty: string) =>
      reportPayload(day.session.data!, [{ itemKey: 'support', qty }], ''),
  };
}

describe('#39 round 1 finding 1 (P1): a report is bound to the crew and day it was typed for', () => {
  it('the reviewer sequence: typed for crew A, moved to crew B during recovery → refused on the phone, never sent', async () => {
    const r = rig();
    await r.day.session.load();
    // A refusal whose rereads fail: the next send must wait for a recovery read.
    r.sv.other('11');
    r.sv.failReads(true);
    expect(await r.day.send(r.typed('9'))).toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    // The foreman types 12 on the form (still crew A, revision 1) and is moved to crew B.
    const draft = r.typed('12');
    r.sv.moveTo(B);
    r.sv.failReads(false);
    const out = await r.day.send(draft);
    expect(out).toMatchObject({ kind: 'rejected', code: 'CREW_CHANGED' });
    // Nothing went out for crew B, and crew B's report is untouched.
    expect(r.sv.log.map((c) => c.crewId)).toEqual([A]);
    expect(r.sv.rev[B]).toEqual({ n: 1, qty: '30' });
    // The form restarts on crew B's report, with the reason and no "you had typed 12".
    const html = r.body();
    expect(html).toContain('value="30"');
    expect(html).toMatch(/You were moved to another crew/);
    expect(html).not.toMatch(/You had typed/);
  });

  // L5: when the move happens × what the first answer is × remount. Invariant: every request
  // carries crew A and the typed 12; crew B's report never changes; crew B's form never shows
  // crew A's typed value as its own.
  for (const move of ['whileSending', 'beforeRetry'] as const)
    for (const first of ['ok', 'lost', 'conflict'] as const)
      it(`moved ${move} · first answer ${first} · remount`, async () => {
        const r = rig();
        await r.day.session.load();
        const draft = r.typed('12'); // typed on crew A, revision 1
        if (first === 'conflict') r.sv.other('11');
        // whileSending: the answer is held while the foreman is moved (then given or lost);
        // beforeRetry: the answer is lost, the foreman is moved, then Retry.
        r.sv.plan.push(
          move === 'whileSending'
            ? first === 'lost'
              ? 'hold-lost'
              : 'hold'
            : 'lost',
        );
        const send = r.day.send(draft);
        await tick();
        await tick();
        if (move === 'whileSending') {
          r.sv.moveTo(B);
          r.sv.held.shift()!();
        }
        let out = await send;
        if (move === 'beforeRetry' || first === 'lost') {
          expect(out.kind).toBe('failed');
          r.sv.moveTo(B);
          await r.day.session.load(); // crew B's report is read meanwhile
          r.advance(60_000);
          out = await r.day.retry();
        }
        expect(out.kind).toBe(first === 'conflict' ? 'rejected' : 'ok');
        await r.day.session.load();
        for (const html of [r.body(), r.body()]) {
          expect(html).toContain('value="30"');
          expect(html).not.toMatch(/You had typed/);
        }
        // Every request: crew A's typed 12, one key, one body.
        expect(r.sv.log.length).toBeGreaterThan(0);
        expect(
          r.sv.log.every(
            (c) =>
              JSON.stringify(c) === JSON.stringify(r.sv.log[0]) &&
              c.crewId === A &&
              c.rows[0]!.qty === '12',
          ),
        ).toBe(true);
        expect(r.sv.rev[B]).toEqual({ n: 1, qty: '30' });
      });

  it('the day is bound too: a payload for another day is refused on the phone', async () => {
    const r = rig();
    await r.day.session.load();
    const out = await r.day.send({
      ...r.typed('12'),
      businessDate: '2026-10-01',
    });
    expect(out).toMatchObject({ code: 'CREW_CHANGED' });
    expect(r.sv.log).toEqual([]);
  });
});

describe('#39 round 1 finding 2: a Retry sends the same body under the same key', () => {
  it('a committed send whose answer was lost, retried a minute later, replays the stored success', async () => {
    const r = rig();
    await r.day.session.load();
    r.sv.plan.push('lost');
    expect((await r.day.send(r.typed('12'))).kind).toBe('failed');
    r.advance(60_000);
    expect(await r.day.retry()).toMatchObject({ kind: 'ok' });
    expect(r.sv.log).toHaveLength(2);
    expect(JSON.stringify(r.sv.log[1])).toBe(JSON.stringify(r.sv.log[0]));
    expect(r.sv.rev[A]).toEqual({ n: 2, qty: '12' });
  });
});

describe('#39 round 1 finding 3: a conflict reached through Retry keeps what was typed', () => {
  for (const path of ['first send', 'retry'] as const)
    it(`${path} → REVISION_CONFLICT: the form shows the latest (15) and "You had typed 12", across remounts`, async () => {
      const r = rig();
      await r.day.session.load();
      const draft = r.typed('12');
      if (path === 'retry')
        r.sv.plan.push('retry'); // 503: nothing stored
      else r.sv.other('15');
      const first = await r.day.send(draft);
      if (path === 'retry') {
        expect(first.kind).toBe('failed');
        r.sv.other('15'); // another send lands meanwhile
        // What the Retry button calls.
        expect(await r.day.retry()).toMatchObject({
          code: 'REVISION_CONFLICT',
        });
      }
      for (const html of [r.body(), r.body()]) {
        expect(html).toContain('value="15"');
        expect(html).toMatch(/You had typed 12/);
      }
    });
});

const W1 = '11111111-1111-4111-8111-111111111111';
const W2 = '22222222-2222-4222-8222-222222222222';
const member = (personId: string) => ({
  personId,
  displayName: personId === W1 ? 'TEST W1' : 'TEST W2',
  currentDeviceId: null,
  pendingDevices: 1,
});
const meWith = (ids: string[]): FieldMeDto => ({
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
  foreman: {
    crewId: 'c',
    crewName: 'TEST crew',
    members: ids.map(member),
  },
});
const record: DeviceRecord = {
  projectId: 'p',
  projectName: 'TEST',
  personId: 'f',
  displayName: 'TEST foreman',
  token: 'fd1.TEST',
  deviceId: 'fd',
  last: {
    state: 'CONFIRMED',
    pendingUntil: null,
    expiresAt: '2027-01-01T00:00:00.000Z',
    memberUntil: null,
  },
} as DeviceRecord;

describe('#39 round 1 finding 4: an ended device is latched on the command answer itself', () => {
  for (const what of ['confirm', 'reject'] as const)
    for (const reread of ['network', 'ok'] as const)
      it(`${what} → DEVICE_ENDED, rereads ${reread}: the page ends and nothing more can start`, async () => {
        let readMode: 'ok' | 'network' = 'ok';
        // The page's own `me` session: no onEnded wired (as in FieldApp).
        const session = new FieldSession<FieldMeDto>(
          async () => {
            if (readMode === 'network') throw new ApiError('NETWORK', 0);
            return meWith([W1]);
          },
          () => {},
        );
        await session.load();
        const commands = new CrewCommands(session, {
          confirmCrew: () => Promise.reject(new ApiError('DEVICE_ENDED', 401)),
          rejectCrew: () => Promise.reject(new ApiError('DEVICE_ENDED', 401)),
        });
        readMode = reread;
        const r = await commands.run({
          personId: W1,
          name: 'TEST W1',
          what,
          code: '111111',
        });
        expect(r).toMatchObject({ code: 'DEVICE_ENDED' });
        await session.load(); // a later read (good or not) cannot bring it back
        const view = deviceView(
          session.data,
          session.readError,
          record,
          new Date('2026-10-02T08:00:00.000Z'),
        );
        expect(view.kind).toBe('ended');
        expect(commands.canStart).toBe(false);
      });

  it('a report send → DEVICE_ENDED with failing rereads: its own session is latched and the page is told', async () => {
    const r = rig();
    await r.day.session.load();
    r.sv.failReads(true);
    r.sv.api.submitReport = () =>
      Promise.reject(new ApiError('DEVICE_ENDED', 401));
    expect(await r.day.send(r.typed('12'))).toMatchObject({
      code: 'DEVICE_ENDED',
    });
    expect(r.ended).toEqual(['DEVICE_ENDED']);
    expect(r.day.session.ended).toBe(true);
    expect(r.day.sends.canStart).toBe(false);
  });
});

describe('#39 round 1 finding 5: an owned attempt keeps its controls after its person leaves the crew', () => {
  const list = (
    me: FieldMeDto,
    commands: CrewCommands,
    flow: ProxyFlow,
    confirming: ReturnType<typeof member> | null = null,
  ) =>
    wrap(
      createElement(CrewList, {
        me,
        commands,
        flow,
        confirming,
        onConfirming: () => {},
      }),
    );
  const proxyFlow = (answer: () => Promise<CheckInResultDto>) =>
    new ProxyFlow({
      api: {
        proxyCheckIn: (_key: string, build: () => ProxyCheckInCommand) => {
          build();
          return answer();
        },
      },
      deviceId: 'fd',
      timeZone: TZ,
      storage: null,
      // TEST coordinates only.
      locate: async () => ({
        fix: {
          lat: '1.000000',
          lon: '1.000000',
          accuracyM: '10.00',
          fixAt: new Date(Date.parse('2026-10-02T08:00:00.000Z')).toISOString(),
        },
        reason: null,
      }),
      now: () => Date.parse('2026-10-02T08:00:00.000Z'),
      newKey: () => 'p1',
      onEnded: () => {},
      notify: () => {},
    });

  it('an unresolved confirmation: the row, its name and the sheet with Retry / Give up stay', async () => {
    let me = meWith([W1, W2]);
    const session = new FieldSession<FieldMeDto>(
      async () => me,
      () => {},
    );
    await session.load();
    const sent: string[] = [];
    const commands = new CrewCommands(session, {
      confirmCrew: async (c) => {
        sent.push(c.personId);
        throw new ApiError('NETWORK', 0);
      },
      rejectCrew: async () => ({}) as never,
    });
    await commands.run({
      personId: W1,
      name: 'TEST W1',
      what: 'confirm',
      code: '111111',
    });
    me = meWith([W2]); // W1 is transferred out; `me` is read again
    await session.load();
    const flow = proxyFlow(async () => ({}) as never);
    for (const html of [list(me, commands, flow), list(me, commands, flow)]) {
      expect(html).toContain('TEST W1');
      expect(html).toMatch(/No longer in your crew/);
      expect(html).not.toContain('—');
    }
    const sheet = list(me, commands, flow, member(W1));
    expect(sheet).toContain('>111111<');
    expect(sheet).toMatch(/Give up/);
    expect(sheet).toMatch(/Retry/);
    // The server decides the retry.
    await commands.retry();
    expect(sent).toEqual([W1, W1]);
  });

  it('an unresolved crew check-in: the row with its Retry stays', async () => {
    const flow = proxyFlow(() => Promise.reject(new ApiError('NETWORK', 0)));
    await flow.checkIn(W1, 'TEST W1');
    expect(flow.phase.kind).toBe('unsettled');
    const session = new FieldSession<FieldMeDto>(
      async () => meWith([W2]),
      () => {},
    );
    await session.load();
    const commands = new CrewCommands(session, {
      confirmCrew: async () => ({}) as never,
      rejectCrew: async () => ({}) as never,
    });
    const html = list(meWith([W2]), commands, flow);
    expect(html).toContain('TEST W1');
    expect(html).toMatch(/No longer in your crew/);
    const row = html.slice(html.indexOf('TEST W1'));
    expect(row.slice(0, row.indexOf('</li>'))).toMatch(/>Retry</);
  });
});
