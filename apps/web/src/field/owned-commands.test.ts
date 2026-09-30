import { describe, expect, it } from 'vitest';
import { ApiError } from '../api.js';
import { OwnedCommands } from './owned-commands.js';
import { FieldSession } from './session.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * A session over a read the test can fail or hold, with every notification recorded together
 * with the ownership state the view would render at that moment.
 */
function rig() {
  let failReads = false;
  let holdReads = false;
  const readHolds: (() => void)[] = [];
  const seen: { owned: boolean; current: string | null }[] = [];
  let oc: OwnedCommands<number, string> | null = null;
  let n = 0;
  const session = new FieldSession<number>(
    async () => {
      if (holdReads) await new Promise<void>((r) => readHolds.push(r));
      if (failReads) throw new ApiError('NETWORK', 0);
      return ++n;
    },
    () => seen.push({ owned: oc!.owned, current: oc!.current }),
  );
  let k = 0;
  oc = new OwnedCommands(session, () => `k${++k}`);
  return {
    session,
    oc,
    seen,
    readHolds,
    failReads: (v: boolean) => (failReads = v),
    holdReads: (v: boolean) => (holdReads = v),
  };
}
const refuse = (key: string) => ({
  key,
  send: () => Promise.reject(new ApiError('VERSION_CONFLICT', 409)),
});
const lose = (key: string) => ({
  key,
  send: () => Promise.reject(new ApiError('NETWORK', 0)),
});

describe('#37 round 4: claiming ownership notifies the view before any recovery read', () => {
  it('after a refusal whose rereads failed: the next action is announced, owned, while its recovery read is held', async () => {
    const r = rig();
    await r.session.load();
    r.failReads(true);
    expect(await r.oc.run('first', (_d, key) => refuse(key))).toMatchObject({
      kind: 'rejected',
    });
    // The recovery read the next action needs is held.
    r.failReads(false);
    r.holdReads(true);
    r.seen.length = 0;
    const sent: string[] = [];
    const next = r.oc.run('second', (_d, key) => ({
      key,
      send: async () => sent.push(key),
    }));
    // Synchronously, before any await: the view was told, and at that moment it is owned.
    expect(r.seen[0]).toEqual({ owned: true, current: 'second' });
    await tick();
    expect(r.readHolds.length).toBe(1);
    expect(r.oc.owned).toBe(true);
    expect(r.session.busy).toBe(false); // nothing sent yet: only the read is pending
    expect(sent).toEqual([]);
    r.holdReads(false);
    r.readHolds.shift()!();
    expect(await next).toMatchObject({ kind: 'ok' });
    expect(sent).toEqual(['k2']);
    expect(r.oc.owned).toBe(false);
  });

  it('with no read yet: the first action is announced before its read', async () => {
    const r = rig();
    r.holdReads(true);
    const run = r.oc.run('only', (_d, key) => refuse(key));
    expect(r.seen[0]).toEqual({ owned: true, current: 'only' });
    await tick();
    r.holdReads(false);
    r.readHolds.shift()!();
    await run;
  });

  it('an action that cannot start claims nothing and changes nothing', async () => {
    const r = rig();
    await r.session.load();
    r.failReads(false);
    await r.oc.run('lost', (_d, key) => lose(key));
    expect(r.oc.unresolved).toBe('lost');
    r.seen.length = 0;
    expect(await r.oc.run('other', (_d, key) => refuse(key))).toMatchObject({
      kind: 'failed',
    });
    expect(r.oc.current).toBe('lost');
    expect(r.seen).toEqual([]);
  });

  it('every ownership transition is announced: retry keeps the payload, give-up releases it', async () => {
    const r = rig();
    await r.session.load();
    await r.oc.run('lost', (_d, key) => lose(key));
    r.seen.length = 0;
    // Retry: still owned by the same action throughout; unresolved again after a lost answer.
    await r.oc.retry();
    expect(r.seen.length).toBeGreaterThan(0);
    expect(r.seen.every((s) => s.owned && s.current === 'lost')).toBe(true);
    expect(r.oc.unresolved).toBe('lost');
    // Give up: released, and the last thing the view is told (synchronously) is released.
    r.seen.length = 0;
    const g = r.oc.generation;
    r.oc.discard();
    expect(r.seen.at(-1)).toEqual({ owned: false, current: null });
    expect(r.oc.generation).toBe(g + 1);
    await tick();
  });
});
