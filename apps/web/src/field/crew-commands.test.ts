import { describe, expect, it } from 'vitest';
import type {
  ChallengeConfirmCommand,
  ChallengeRejectCommand,
  FieldMeDto,
} from '@mje/contracts';
import { ApiError } from '../api.js';
import { CrewCommands } from './crew-commands.js';
import { crewDecision } from './foreman-report.js';
import { FieldSession, type Outcome } from './session.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const W = '44444444-4444-4444-8444-444444444444';
const W2 = '77777777-7777-4777-8777-777777777777';
const RIGHT = '119743';
const WRONG = '000000';
const me: FieldMeDto = {
  device: {
    deviceId: 'd',
    state: 'CONFIRMED',
    generation: 0,
    pendingUntil: null,
    expiresAt: '2027-01-01T00:00:00.000Z',
    memberUntil: null,
    tokenIssuedAt: '2026-10-01T00:00:00.000Z',
  },
  person: { id: 'f', displayName: 'TEST foreman' },
  project: { id: 'p', name: 'TEST', timezone: 'Europe/Belgrade' },
  settings: { selfieEnabled: false },
  crew: null,
  foreman: {
    crewId: 'c',
    crewName: 'TEST crew',
    members: [W, W2].map((personId) => ({
      personId,
      displayName: `TEST ${personId.slice(0, 2)}`,
      currentDeviceId: null,
      pendingDevices: 1,
    })),
  },
};

/**
 * A fake server with the design's semantics (§2 "Failed matches"): a wrong code is decided
 * and stored as the key's result, so a same-key retry replays it without a new event; RETRY
 * (503) and a lost answer commit nothing. Every request is logged.
 */
function harness() {
  const log: string[] = [];
  const stored = new Map<string, Outcome<unknown>>();
  let events = 0;
  const plan: ('ok' | 'retry' | 'lost')[] = [];
  const reads: { settle: (v: FieldMeDto | Error) => void }[] = [];
  let autoRead = true;
  const decide = (c: { clientMutationId: string; code: string }) => {
    const mode = plan.shift() ?? 'ok';
    log.push(`${c.clientMutationId} ${c.code} ${mode}`);
    if (mode === 'retry') return Promise.reject(new ApiError('RETRY', 503));
    const prior = stored.get(c.clientMutationId);
    let out: Outcome<unknown>;
    if (prior) out = prior;
    else {
      events++;
      out =
        c.code === RIGHT
          ? { kind: 'ok', value: { state: 'CONFIRMED' } }
          : {
              kind: 'rejected',
              code: 'CHALLENGE_INVALID',
              error: null,
              uncertain: false,
            };
      stored.set(c.clientMutationId, out);
    }
    if (mode === 'lost') return Promise.reject(new ApiError('NETWORK', 0));
    return out.kind === 'ok'
      ? Promise.resolve(out.value)
      : Promise.reject(new ApiError('CHALLENGE_INVALID', 409));
  };
  const api = {
    confirmCrew: (c: ChallengeConfirmCommand) => decide(c) as Promise<never>,
    rejectCrew: (c: ChallengeRejectCommand) => decide(c) as Promise<never>,
  };
  const session = new FieldSession<FieldMeDto>(
    () =>
      autoRead
        ? Promise.resolve(me)
        : new Promise((resolve, reject) =>
            reads.push({
              settle: (v) => (v instanceof Error ? reject(v) : resolve(v)),
            }),
          ),
    () => {},
  );
  let n = 0;
  const commands = new CrewCommands(session, api, () => `K${++n}`);
  return {
    session,
    commands,
    api,
    log,
    plan,
    reads,
    events: () => events,
    manualReads: () => (autoRead = false),
  };
}

describe('foreman confirm: a correct code is never answered with an earlier decision', () => {
  it('reproduces the reported symptom with the pre-fix sheet logic', async () => {
    // The sheet as it was at 0c6d6e6: an unresolved command is retried whatever is typed.
    const h = harness();
    await h.session.load();
    let code = WRONG;
    const oldRun = () =>
      h.session.pending
        ? h.session.retry()
        : h.session.act((m) => {
            const key = `old-${code}`;
            const d = crewDecision(m, W, code, key, 'confirm');
            return d
              ? { key, send: () => h.api.confirmCrew(d.command as never) }
              : null;
          });
    h.plan.push('retry', 'ok');
    expect((await oldRun()).kind).toBe('failed'); // 503: nothing decided, command kept
    code = RIGHT; // the foreman types the correct code and presses the button
    const second = await oldRun();
    expect(second).toMatchObject({
      kind: 'rejected',
      code: 'CHALLENGE_INVALID',
    });
    // The log shows what happened: the old code was sent again; the correct one never.
    expect(h.log).toEqual([
      `old-${WRONG} ${WRONG} retry`,
      `old-${WRONG} ${WRONG} ok`,
    ]);
    expect(h.events()).toBe(1);
  });

  it('ordering 1: wrong code decided, then the correct code → a new key carrying the correct code', async () => {
    const h = harness();
    await h.session.load();
    expect(
      await h.commands.run({
        personId: W,
        name: 'TEST',
        what: 'confirm',
        code: WRONG,
      }),
    ).toMatchObject({
      kind: 'rejected',
      code: 'CHALLENGE_INVALID',
    });
    expect(h.commands.unresolved).toBeNull();
    expect(
      (
        await h.commands.run({
          personId: W,
          name: 'TEST',
          what: 'confirm',
          code: RIGHT,
        })
      ).kind,
    ).toBe('ok');
    expect(h.log).toEqual([`K1 ${WRONG} ok`, `K2 ${RIGHT} ok`]);
  });

  it('ordering 2: the correct code pressed while the reread after the refusal is in flight waits for it, then sends', async () => {
    const h = harness();
    await h.session.load();
    h.manualReads();
    const first = h.commands.run({
      personId: W,
      name: 'TEST',
      what: 'confirm',
      code: WRONG,
    });
    await tick();
    const second = h.commands.run({
      personId: W,
      name: 'TEST',
      what: 'confirm',
      code: RIGHT,
    });
    await tick();
    expect(h.log).toHaveLength(1);
    h.reads[0]!.settle(me);
    expect((await first).kind).toBe('rejected');
    await tick();
    // canStart was false while the first ran: the second is refused, never sent stale.
    const out = await second;
    expect(out.kind).toBe('failed');
    expect(h.log).toHaveLength(1);
    // Pressed again once the reread landed: sent with the correct code.
    const third = h.commands.run({
      personId: W,
      name: 'TEST',
      what: 'confirm',
      code: RIGHT,
    });
    await tick();
    h.reads[1]?.settle(me);
    expect((await third).kind).toBe('ok');
    expect(h.log[1]).toBe(`K2 ${RIGHT} ok`);
  });

  it('ordering 3: the reread after the refusal fails → the next press waits for a fresh read, nothing stale is sent', async () => {
    const h = harness();
    await h.session.load();
    h.manualReads();
    const first = h.commands.run({
      personId: W,
      name: 'TEST',
      what: 'confirm',
      code: WRONG,
    });
    for (let i = 0; i < 3; i++) {
      await tick();
      h.reads[i]!.settle(new ApiError('NETWORK', 0));
    }
    expect((await first).kind).toBe('rejected');
    const second = h.commands.run({
      personId: W,
      name: 'TEST',
      what: 'confirm',
      code: RIGHT,
    });
    for (let i = 3; i < 6; i++) {
      await tick();
      h.reads[i]!.settle(new ApiError('NETWORK', 0));
    }
    expect(await second).toEqual({ kind: 'failed', code: 'STALE' });
    expect(h.log).toHaveLength(1);
  });

  it('ordering 4 (the defect): an unresolved attempt keeps its code; retry sends it, a new code needs giving up first', async () => {
    const h = harness();
    await h.session.load();
    h.plan.push('retry');
    expect(
      (
        await h.commands.run({
          personId: W,
          name: 'TEST',
          what: 'confirm',
          code: WRONG,
        })
      ).kind,
    ).toBe('failed');
    expect(h.commands.unresolved).toEqual({
      personId: W,
      name: 'TEST',
      what: 'confirm',
      code: WRONG,
    });
    // Nothing new can start (another member, or this member with another code).
    expect(h.commands.canStart).toBe(false);
    expect(
      (
        await h.commands.run({
          personId: W,
          name: 'TEST',
          what: 'confirm',
          code: RIGHT,
        })
      ).kind,
    ).toBe('failed');
    expect(
      (
        await h.commands.run({
          personId: W2,
          name: 'TEST',
          what: 'confirm',
          code: RIGHT,
        })
      ).kind,
    ).toBe('failed');
    expect(h.log).toHaveLength(1);
    // Retry: the command that was sent (and shown, locked) is resent under its key.
    expect(await h.commands.retry()).toMatchObject({
      code: 'CHALLENGE_INVALID',
    });
    expect(h.log).toEqual([`K1 ${WRONG} retry`, `K1 ${WRONG} ok`]);
    // Now the correct code goes out under a new key.
    expect(
      (
        await h.commands.run({
          personId: W,
          name: 'TEST',
          what: 'confirm',
          code: RIGHT,
        })
      ).kind,
    ).toBe('ok');
    expect(h.log[2]).toBe(`K2 ${RIGHT} ok`);
  });

  it('giving up an unresolved attempt lets the correct code go out under a new key', async () => {
    const h = harness();
    await h.session.load();
    h.plan.push('lost');
    await h.commands.run({
      personId: W,
      name: 'TEST',
      what: 'confirm',
      code: WRONG,
    });
    expect(h.commands.isUnresolved(W)).toBe(true);
    h.commands.discard();
    await tick();
    expect(h.commands.canStart).toBe(true);
    expect(
      (
        await h.commands.run({
          personId: W,
          name: 'TEST',
          what: 'confirm',
          code: RIGHT,
        })
      ).kind,
    ).toBe('ok');
    expect(h.log).toEqual([`K1 ${WRONG} lost`, `K2 ${RIGHT} ok`]);
  });

  it('an attempt started during a recovery read owns its command at once; another member cannot claim it', async () => {
    const h = harness();
    await h.session.load();
    h.manualReads();
    // A refused attempt whose rereads fail: the next attempt needs a recovery read.
    const first = h.commands.run({
      personId: W,
      name: 'TEST',
      what: 'confirm',
      code: WRONG,
    });
    for (let i = 0; i < 3; i++) {
      await tick();
      h.reads[i]!.settle(new ApiError('NETWORK', 0));
    }
    await first;
    h.plan.push('lost');
    const a = h.commands.run({
      personId: W,
      name: 'TEST',
      what: 'confirm',
      code: RIGHT,
    });
    await tick();
    // While A waits for its recovery read, B cannot start (nothing sent for B, ever).
    expect(h.commands.canStart).toBe(false);
    expect(h.commands.current).toEqual({
      personId: W,
      name: 'TEST',
      what: 'confirm',
      code: RIGHT,
    });
    const b = h.commands.run({
      personId: W2,
      name: 'TEST',
      what: 'confirm',
      code: WRONG,
    });
    h.reads[3]!.settle(me);
    expect((await b).kind).toBe('failed');
    expect((await a).kind).toBe('failed');
    expect(h.commands.unresolved).toEqual({
      personId: W,
      name: 'TEST',
      what: 'confirm',
      code: RIGHT,
    });
    expect(h.log.slice(1)).toEqual([`K2 ${RIGHT} lost`]);
    const r = h.commands.retry();
    await tick();
    h.reads.at(-1)?.settle(me);
    expect((await r).kind).toBe('ok');
    expect(h.log.at(-1)).toBe(`K2 ${RIGHT} ok`);
  });
});
