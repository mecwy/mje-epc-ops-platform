import { describe, expect, it } from 'vitest';
import type { DayFactsDto, SaveFactsCommand } from '@mje/contracts';
import { blankFacts } from '@mje/domain/rules';
import { ApiError, type WriteResult } from '../api.js';
import { DraftSession } from './draft.js';
import { setFact } from './model.js';

const empty = () => blankFacts() as DayFactsDto;
const withQty = (q: string) => setFact(empty(), 'qty.support', q);

/** A server whose responses the test releases one by one. */
function server() {
  const calls: {
    command: SaveFactsCommand;
    settle: (r: WriteResult | Error) => void;
  }[] = [];
  const write = (command: SaveFactsCommand) =>
    new Promise<WriteResult>((resolve, reject) => {
      calls.push({
        command,
        settle: (r) => (r instanceof Error ? reject(r) : resolve(r)),
      });
    });
  const ok = (i: number, version: number) =>
    calls[i]!.settle({
      businessDate: calls[i]!.command.businessDate,
      version,
      state: 'draft',
    });
  return { calls, write, ok };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
let id = 0;
const session = (date: string, s: ReturnType<typeof server>, version = 1) =>
  new DraftSession(
    'p',
    date,
    version,
    empty(),
    s.write,
    () => undefined,
    () => `k${++id}`,
  );

describe('draft session', () => {
  it("a save in flight for one day never writes another day's facts", async () => {
    const srv = server();
    const a = session('2026-09-29', srv);
    const b = session('2026-09-30', srv, 7);
    a.edit(withQty('2'));
    const pending = a.flush();
    await tick();
    b.edit(withQty('22'));
    const bFlush = b.flush();
    await tick();
    srv.ok(0, 2);
    await pending;
    srv.ok(1, 8);
    await bFlush;
    const byDate = srv.calls.map((c) => [
      c.command.businessDate,
      c.command.facts.qty['support'],
      c.command.expectedVersion,
    ]);
    expect(byDate).toEqual([
      ['2026-09-29', '2', 1],
      ['2026-09-30', '22', 7],
    ]);
  });

  it('a conflict stops the queue and settle reports it, so no action follows', async () => {
    const srv = server();
    const s = session('d', srv);
    s.edit(withQty('2'));
    const settled = s.settle();
    await tick();
    srv.calls[0]!.settle(new ApiError('VERSION_CONFLICT', 409));
    expect(await settled).toBe('conflict');
    expect(s.state).toBe('conflict');
    expect(srv.calls).toHaveLength(1);
  });

  it('an invalid edit made while a save is outstanding prevents settling', async () => {
    const srv = server();
    const s = session('d', srv);
    s.edit(withQty('2'));
    const settled = s.settle();
    await tick();
    s.edit(withQty('2x'));
    srv.ok(0, 2);
    expect(await settled).toBe('invalid');
    expect(srv.calls).toHaveLength(1);
  });

  it('settle waits for edits typed during the flush and returns only when all are saved', async () => {
    const srv = server();
    const s = session('d', srv);
    s.edit(withQty('2'));
    const settled = s.settle();
    await tick();
    s.edit(withQty('3'));
    srv.ok(0, 2);
    await tick();
    expect(srv.calls[1]!.command.facts.qty['support']).toBe('3');
    expect(srv.calls[1]!.command.expectedVersion).toBe(2);
    srv.ok(1, 3);
    expect(await settled).toBe('ok');
    expect(s.version).toBe(3);
    expect(s.dirty).toBe(false);
  });

  it('a write whose response was lost is resent with the same key before anything newer', async () => {
    const srv = server();
    const s = session('d', srv);
    s.edit(withQty('2'));
    const first = s.flush();
    await tick();
    srv.calls[0]!.settle(new ApiError('NETWORK', 0)); // committed on the server, response lost
    expect(await first).toBe('failed');
    s.edit(withQty('3'));
    const second = s.flush();
    await tick();
    expect(srv.calls[1]!.command.clientMutationId).toBe(
      srv.calls[0]!.command.clientMutationId,
    );
    expect(srv.calls[1]!.command.facts.qty['support']).toBe('2');
    srv.ok(1, 2); // the server replays the original result
    await tick();
    expect(srv.calls[2]!.command.facts.qty['support']).toBe('3');
    expect(srv.calls[2]!.command.expectedVersion).toBe(2);
    srv.ok(2, 3);
    expect(await second).toBe('ok');
  });

  it('a permanent failure does not retry by itself', async () => {
    const srv = server();
    const s = session('d', srv);
    s.edit(withQty('2'));
    const first = s.flush();
    await tick();
    srv.calls[0]!.settle(new ApiError('READ_ONLY', 403));
    expect(await first).toBe('failed');
    expect(await s.flush()).toBe('failed');
    expect(srv.calls).toHaveLength(1);
  });

  it('reset adopts server state and drops local edits (used only after a conflict)', () => {
    const srv = server();
    const s = session('d', srv);
    s.edit(withQty('2'));
    s.reset(5, withQty('99'));
    expect(s.dirty).toBe(false);
    expect(s.version).toBe(5);
    expect(s.facts.qty['support']).toBe('99');
  });
});
