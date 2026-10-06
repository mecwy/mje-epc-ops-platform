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
  it.each([1, 2] as const)(
    'retains source cells through ordinary edits and byte-identical retry after a lost response (V%s)',
    async (schemaVersion) => {
      const sourceReport = {
        documents: {
          testDoc: {
            sha256: 'a'.repeat(64),
            label: 'TEST source',
            format: 'docx',
          },
        },
        peopleTotal: {
          raw: ' 7 ',
          state: 'value',
          at: { document: 'testDoc', table: 0, row: 1, cell: 2 },
        },
        workPercent: {},
        materials: {},
        ...(schemaVersion === 2
          ? {
              schemaVersion: 2 as const,
              reportedNextPlan: {
                targetBusinessDate: '2025-03-11',
                quantities: {
                  testWork: {
                    raw: ' 23 ',
                    state: 'value' as const,
                    at: { document: 'testDoc', table: 2, row: 1, cell: 7 },
                  },
                },
              },
            }
          : { schemaVersion: 1 as const }),
      } as const;
      const original: DayFactsDto = { ...empty(), sourceReport };
      const srv = server();
      const s = new DraftSession(
        'p',
        '2025-03-10',
        1,
        original,
        srv.write,
        () => undefined,
        () => `k${++id}`,
      );
      s.edit(setFact(original, 'weather', 'TEST cloudy'));
      const first = s.flush();
      await tick();
      const sent = JSON.stringify(srv.calls[0]!.command);
      expect(srv.calls[0]!.command.facts.sourceReport).toEqual(sourceReport);
      srv.calls[0]!.settle(new ApiError('NETWORK', 0));
      expect(await first).toBe('failed');
      const retry = s.flush();
      await tick();
      expect(JSON.stringify(srv.calls[1]!.command)).toBe(sent);
      srv.ok(1, 2);
      await retry;
      expect(s.facts.sourceReport).toEqual(sourceReport);
      expect(original.weather).toBe('');
    },
  );

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

describe('draft session: reads and locks', () => {
  it('an older read never replaces newer acknowledged facts', async () => {
    const srv = server();
    const s = session('d', srv);
    const startedAt = s.editGeneration; // a read of version 1 / qty 1 starts here
    s.edit(withQty('2'));
    const f = s.flush();
    await tick();
    srv.ok(0, 2);
    await f;
    expect(s.adopt({ version: 1, facts: withQty('1') }, startedAt)).toBe(false);
    expect(s.facts.qty['support']).toBe('2');
    expect(s.version).toBe(2);
  });
  it('a read that started before an edit is not adopted, even at the same version', () => {
    const srv = server();
    const s = session('d', srv, 3);
    const startedAt = s.editGeneration;
    s.edit(withQty('5'));
    expect(s.adopt({ version: 3, facts: withQty('1') }, startedAt)).toBe(false);
    expect(s.facts.qty['support']).toBe('5');
  });
  it('a current read with nothing unsaved is adopted', () => {
    const srv = server();
    const s = session('d', srv, 3);
    expect(s.adopt({ version: 4, facts: withQty('9') }, s.editGeneration)).toBe(
      true,
    );
    expect(s.version).toBe(4);
  });
  it('edits are refused while an action holds the session', () => {
    const srv = server();
    const s = session('d', srv);
    s.locked = true;
    expect(s.edit(withQty('7'))).toBe(false);
    expect(s.dirty).toBe(false);
  });
});

describe('input set aside by a conflict reload', () => {
  const withPeople = (f: DayFactsDto, n: string) =>
    setFact(f, 'people.installer', n);
  /** Type, let the save conflict, then adopt what the server holds now. */
  async function conflicted(serverFacts: DayFactsDto, version = 3) {
    const srv = server();
    const s = session('d', srv);
    s.edit(withPeople(withQty('7'), '3'));
    const settled = s.settle();
    await tick();
    srv.calls[0]!.settle(new ApiError('VERSION_CONFLICT', 409));
    expect(await settled).toBe('conflict');
    // The replacement read has not landed yet: nothing is lost and nothing is set aside.
    expect(s.facts.qty['support']).toBe('7');
    expect(s.dirty).toBe(true);
    expect(s.retained).toEqual([]);
    s.reset(version, serverFacts);
    return { srv, s };
  }

  it('keeps what was typed, not untouched fields nor a field the server now holds alike', async () => {
    const server_ = setFact(withPeople(withQty('5'), '3'), 'weather', 'sunny');
    const { s } = await conflicted(server_);
    expect(s.retained).toEqual([{ path: 'qty.support', mine: '7' }]);
    expect(s.facts).toBe(server_);
    expect(s.dirty).toBe(false);
    expect(s.state).toBe('idle');
  });

  it('a field another person cleared is shown against empty and filled in again on the new version', async () => {
    const { srv, s } = await conflicted(withPeople(empty(), '3'));
    expect(s.retained).toEqual([{ path: 'qty.support', mine: '7' }]);
    expect(s.facts.qty['support']).toBeUndefined();
    expect(s.refill('qty.support')).toBe(true);
    expect(s.retained).toEqual([]);
    expect(s.facts.qty['support']).toBe('7');
    const flushed = s.flush();
    await tick();
    expect(srv.calls[1]!.command.expectedVersion).toBe(3);
    expect(srv.calls[1]!.command.facts.qty['support']).toBe('7');
    srv.ok(1, 4);
    expect(await flushed).toBe('ok');
    expect(s.dirty).toBe(false);
  });

  it('a conflict on the refilled value sets it aside again; an earlier one not yet handled stays', async () => {
    const { srv, s } = await conflicted(
      setFact(withPeople(withQty('5'), '9'), 'weather', 'x'),
    );
    const paths = () => s.retained.map((r) => r.path).sort();
    expect(paths()).toEqual(['people.installer', 'qty.support']);
    s.refill('qty.support');
    const flushed = s.flush();
    await tick();
    srv.calls[1]!.settle(new ApiError('VERSION_CONFLICT', 409));
    expect(await flushed).toBe('conflict');
    s.reset(5, withPeople(withQty('8'), '9'));
    expect(paths()).toEqual(['people.installer', 'qty.support']);
    expect(s.retained.find((r) => r.path === 'qty.support')?.mine).toBe('7');
    expect(s.facts.qty['support']).toBe('8');
  });

  it('editing the field drops its set-aside input; editing another field keeps it', async () => {
    const { s } = await conflicted(withPeople(withQty('5'), '9'));
    s.edit(setFact(s.facts, 'weather', 'rain'));
    expect(s.retained.map((r) => r.path).sort()).toEqual([
      'people.installer',
      'qty.support',
    ]);
    s.edit(setFact(s.facts, 'qty.support', '6'));
    expect(s.retained.map((r) => r.path)).toEqual(['people.installer']);
  });

  it('ignoring drops the input without touching the facts', async () => {
    const { s } = await conflicted(withPeople(withQty('5'), '3'));
    s.dismiss('qty.support');
    expect(s.retained).toEqual([]);
    expect(s.facts.qty['support']).toBe('5');
    expect(s.dirty).toBe(false);
  });

  it('nothing is filled in again while an action or a hold freezes the session', async () => {
    const { s } = await conflicted(withPeople(withQty('5'), '3'));
    s.locked = true;
    expect(s.refill('qty.support')).toBe(false);
    expect(s.retained).toEqual([{ path: 'qty.support', mine: '7' }]);
    expect(s.facts.qty['support']).toBe('5');
  });

  it('an input set aside earlier is dropped once the server holds that value; a settled reset keeps nothing', async () => {
    const { s } = await conflicted(withPeople(withQty('5'), '3'));
    s.reset(4, withPeople(withQty('7'), '3'));
    expect(s.retained).toEqual([]);
    s.reset(5, withPeople(withQty('1'), '3'));
    expect(s.retained).toEqual([]);
  });
});
