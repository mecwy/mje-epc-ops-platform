import { describe, expect, it } from 'vitest';
import type { FieldDeviceDto, PmDeviceCommand } from '@mje/contracts';
import { ApiError } from '../api.js';
import { DeviceCommands } from './site-sessions.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const P = '11111111-1111-4111-8111-111111111111';
const device = (id: string): FieldDeviceDto => ({
  id,
  personId: `p-${id}`,
  displayName: `TEST ${id}`,
  state: 'CONFIRMED',
  effectiveState: 'CONFIRMED',
  endReason: null,
  version: 1,
  createdAt: '2026-10-01T08:00:00.000Z',
  confirmedAt: null,
  confirmedBy: null,
  lastSeenAt: '2026-10-01T08:00:00.000Z',
  expiresAt: '2027-03-30T08:00:00.000Z',
  memberUntil: null,
});
type Outcome = 'success' | 'lost' | 'refused';
type Timing = 'in flight' | 'landing before' | 'landing after';

/**
 * The PM device list's commands under a recovery read (L5 feedback): a first command is
 * refused with a conflict whose rereads fail, so the next action must wait for a recovery
 * read. Reads and writes are settled by the test; every request is logged with its key.
 */
function harness() {
  const reads: { settle: (v: FieldDeviceDto[] | Error) => void }[] = [];
  const writes: {
    key: string;
    deviceId: string;
    settle: (e?: Error) => void;
  }[] = [];
  const write = (c: PmDeviceCommand) =>
    new Promise<unknown>((resolve, reject) =>
      writes.push({
        key: c.clientMutationId,
        deviceId: c.deviceId,
        settle: (e) => (e ? reject(e) : resolve({})),
      }),
    );
  let n = 0;
  const commands = new DeviceCommands(
    {
      devices: () =>
        new Promise((resolve, reject) =>
          reads.push({
            settle: (v) => (v instanceof Error ? reject(v) : resolve(v)),
          }),
        ),
      revokeDevice: write,
      rejectDevice: write,
    } as never,
    P,
    () => {},
    () => `key-${++n}`,
  );
  return { commands, reads, writes };
}
const list = [device('A'), device('B')];

/** Load, then a conflict on A whose rereads all fail: the next action needs a recovery read. */
async function afterFailedRecovery() {
  const h = harness();
  const l = h.commands.session.load();
  h.reads[0]!.settle(list);
  await l;
  const c = h.commands.run({ kind: 'revoke', device: device('A') });
  await tick();
  h.writes[0]!.settle(new ApiError('VERSION_CONFLICT', 409));
  for (let i = 1; i <= 3; i++) {
    await tick();
    h.reads[i]!.settle(new ApiError('NETWORK', 0));
  }
  await c;
  expect(h.commands.unresolved).toBeNull();
  return h;
}
const settle = (w: { settle: (e?: Error) => void }, o: Outcome) =>
  w.settle(
    o === 'success'
      ? undefined
      : o === 'lost'
        ? new ApiError('NETWORK', 0)
        : new ApiError('VERSION_CONFLICT', 409),
  );

describe('#37 round 2: an unresolved Retry always belongs to its own device and action', () => {
  const outcomes: Outcome[] = ['success', 'lost', 'refused'];
  const timings: Timing[] = ['in flight', 'landing before', 'landing after'];
  for (const timing of timings)
    for (const outcome of outcomes)
      for (const second of ['same device', 'another device'] as const)
        it(`recovery read ${timing} · A ${outcome} · then ${second}`, async () => {
          const h = await afterFailedRecovery();
          const other = second === 'same device' ? device('A') : device('B');
          const readsBefore = h.reads.length;
          const writesBefore = h.writes.length;
          // A (revoke) starts: it must wait for a recovery read first.
          const a = h.commands.run({ kind: 'revoke', device: device('A') });
          await tick();
          expect(h.reads.length).toBe(readsBefore + 1);
          let b: ReturnType<typeof h.commands.run> | null = null;
          if (timing === 'in flight') {
            // B's sheet submits while the recovery read is in flight (busy is still false).
            b = h.commands.run({ kind: 'reject', device: other });
            await tick();
          }
          h.reads[readsBefore]!.settle(list);
          await tick();
          if (timing === 'landing before') {
            // The read has landed; A's command is on the wire.
            b = h.commands.run({ kind: 'reject', device: other });
            await tick();
          }
          const aWrite = h.writes.at(-1)!;
          expect(aWrite.deviceId).toBe('A');
          settle(aWrite, outcome);
          await tick();
          // A decided or lost; its reread (when decided) lands.
          if (outcome !== 'lost') {
            await tick();
            h.reads.at(-1)!.settle(list);
          }
          await a;
          // Invariant: the unresolved action is exactly the command kept for Retry.
          const u = h.commands.unresolved;
          if (timing === 'landing after')
            b = h.commands.run({ kind: 'reject', device: other });
          await tick();
          const bOut = b
            ? await Promise.race([b, tick().then(() => null)])
            : null;
          if (outcome === 'lost') {
            expect(u).toMatchObject({ kind: 'revoke', device: { id: 'A' } });
            // B never sent, never claimed A's command.
            expect(
              h.writes.slice(writesBefore).filter((w) => w.key !== aWrite.key),
            ).toEqual([]);
            if (bOut) expect(bOut.kind).toBe('failed');
            const r = h.commands.retry();
            await tick();
            expect(h.writes.at(-1)).toMatchObject({
              deviceId: 'A',
              key: aWrite.key,
            });
            h.writes.at(-1)!.settle();
            await tick();
            h.reads.at(-1)!.settle(list);
            expect((await r).kind).toBe('ok');
            expect(h.commands.unresolved).toBeNull();
          } else {
            expect(u).toBeNull();
            if (timing !== 'landing after') {
              // Started while A was running: refused outright, nothing sent for it.
              expect(bOut?.kind).toBe('failed');
              expect(h.writes).toHaveLength(writesBefore + 1);
            } else {
              // Started after A was decided: B goes out under its own key.
              const bw = h.writes.at(-1)!;
              expect(bw).toMatchObject({ deviceId: other.id });
              expect(bw.key).not.toBe(aWrite.key);
            }
          }
        });
});
