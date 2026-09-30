import { describe, expect, it } from 'vitest';
import { ApiError } from '../api.js';
import { FieldSession } from './session.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Reads and sends the test settles one by one. */
function harness() {
  const reads: { settle: (v: number | Error) => void }[] = [];
  const sent: { key: string; body: unknown; settle: (e?: Error) => void }[] =
    [];
  const session = new FieldSession<number>(
    () =>
      new Promise((resolve, reject) =>
        reads.push({
          settle: (v) => (v instanceof Error ? reject(v) : resolve(v)),
        }),
      ),
    () => {},
  );
  const command = (key: string, body: () => unknown) => ({
    key,
    send: () =>
      new Promise<string>((resolve, reject) =>
        sent.push({
          key,
          body: body(),
          settle: (e) => (e ? reject(e) : resolve(`ok:${key}`)),
        }),
      ),
  });
  return { session, reads, sent, command };
}

describe('FieldSession (IssueSession pattern)', () => {
  it('an older read never overwrites a newer one', async () => {
    const { session, reads } = harness();
    const a = session.load();
    const b = session.load();
    reads[1]!.settle(2);
    await b;
    reads[0]!.settle(1);
    expect(await a).toBe(false);
    expect(session.data).toBe(2);
  });

  it('keeps an unsettled command and resends it unchanged (same key and event)', async () => {
    const { session, reads, sent, command } = harness();
    void session.load();
    reads[0]!.settle(1);
    await tick();
    let clock = 100;
    const run = session.act(
      () => command('K1', () => ({ event: 'E', deviceSentAt: clock })),
      false,
    );
    await tick();
    sent[0]!.settle(new ApiError('NETWORK', 0));
    expect(await run).toEqual({ kind: 'failed', code: 'NETWORK' });
    expect(session.pending?.key).toBe('K1');
    expect(session.needsRetry).toBe(true);
    // Another command is refused while one is unresolved: nothing new is sent.
    expect(await session.act(() => command('K2', () => ({})), false)).toEqual({
      kind: 'failed',
      code: 'NETWORK',
    });
    expect(sent).toHaveLength(1);
    clock = 200;
    const again = session.retry<string>();
    await tick();
    expect(sent[1]!.key).toBe('K1');
    // Only transport is refreshed per attempt; the event stays the same.
    expect(sent[1]!.body).toEqual({ event: 'E', deviceSentAt: 200 });
    sent[1]!.settle();
    expect(await again).toEqual({ kind: 'ok', value: 'ok:K1' });
    expect(session.pending).toBeNull();
  });

  it('RETRY and RATE_LIMITED keep the command; a decision drops it', async () => {
    const { session, reads, sent, command } = harness();
    void session.load();
    reads[0]!.settle(1);
    await tick();
    for (const code of ['RETRY', 'RATE_LIMITED', 'REQUEST_FAILED']) {
      const r = session.pending
        ? session.retry()
        : session.act(() => command('K', () => ({})), false);
      await tick();
      sent.at(-1)!.settle(new ApiError(code, 503));
      expect((await r).kind).toBe('failed');
      expect(session.pending?.key).toBe('K');
    }
    const r = session.retry();
    await tick();
    sent.at(-1)!.settle(new ApiError('GEOFENCE_OUTSIDE', 409));
    const out = await r;
    expect(out.kind).toBe('rejected');
    expect(session.pending).toBeNull();
    expect(session.error).toBe('GEOFENCE_OUTSIDE');
  });

  it('after a write the next command waits for a read started after it, built from that read', async () => {
    const { session, reads, sent, command } = harness();
    void session.load();
    reads[0]!.settle(1);
    await tick();
    const first = session.act((v) => command(`v${v}`, () => ({})));
    await tick();
    sent[0]!.settle();
    await tick();
    // The write asked for a reread; it has not landed yet.
    expect(reads).toHaveLength(2);
    const second = session.act((v) => command(`v${v}`, () => ({})));
    await tick();
    expect(sent).toHaveLength(1);
    reads[1]!.settle(2);
    expect((await first).kind).toBe('ok');
    await tick();
    expect(sent[1]!.key).toBe('v2');
    sent[1]!.settle();
    await tick();
    reads[2]!.settle(3);
    expect((await second).kind).toBe('ok');
  });

  it('never builds a command from data older than the last write when rereads fail', async () => {
    const { session, reads, sent, command } = harness();
    void session.load();
    reads[0]!.settle(1);
    await tick();
    const w = session.act(() => command('W', () => ({})));
    await tick();
    sent[0]!.settle();
    for (let i = 1; i <= 3; i++) {
      await tick();
      reads[i]!.settle(new ApiError('NETWORK', 0));
    }
    expect((await w).kind).toBe('ok');
    expect(session.error).toBe('STALE');
    const next = session.act(() => command('X', () => ({})));
    for (let i = 4; i <= 6; i++) {
      await tick();
      reads[i]!.settle(new ApiError('NETWORK', 0));
    }
    expect(await next).toEqual({ kind: 'failed', code: 'STALE' });
    expect(sent).toHaveLength(1);
  });

  it('a target that is not loaded is refused without sending', async () => {
    const { session, reads, sent } = harness();
    void session.load();
    reads[0]!.settle(1);
    await tick();
    expect((await session.act(() => null)).kind).toBe('rejected');
    expect(sent).toHaveLength(0);
  });
});
