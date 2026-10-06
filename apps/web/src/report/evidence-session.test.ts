import { describe, expect, it } from 'vitest';
import type {
  BusinessEvidenceCommand,
  EvidenceWorkspace,
} from '../../../../packages/contracts/src/business-evidence.js';
import { ApiError } from '../api.js';
import { EvidenceSession, type EvidencePort } from './evidence-session.js';

// Synthetic TEST provider only; the runtime component has no fallback provider.
const uuid = (n: number) =>
  `10000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const target = {
  projectId: uuid(1),
  businessDate: '2026-10-06',
  crewId: uuid(2),
  foremanRevisionId: uuid(3),
  itemKey: 'TEST-install',
};
const coverage = {
  scopeRef: uuid(4),
  withinScopeRef: uuid(4),
  qty: '10',
  unit: 'TEST-m',
};
const workspace = (): EvidenceWorkspace => ({
  target,
  revisionNumber: 2,
  declaration: { qty: '10', unit: 'TEST-m', scopeRef: uuid(4) },
  evidence: null,
  associationCoverage: null,
  availablePhotos: [
    { photoId: uuid(7), photoVersion: 3, label: 'TEST-existing-photo' },
  ],
  scopes: [{ id: uuid(4), withinScopeRef: uuid(4), label: 'TEST-whole' }],
  history: [],
  canBind: true,
});
function fake() {
  let data = workspace();
  const sent: BusinessEvidenceCommand[] = [];
  let read: () => Promise<EvidenceWorkspace> = async () =>
    structuredClone(data);
  let command: (
    c: BusinessEvidenceCommand,
  ) => Promise<unknown> = async () => ({});
  const port: EvidencePort = {
    read: () => read(),
    command: (c) => {
      sent.push(structuredClone(c));
      return command(c);
    },
  };
  const s = new EvidenceSession(target, port, () => uuid(9));
  return {
    s,
    sent,
    setData: (d: EvidenceWorkspace) => {
      data = d;
    },
    setRead: (r: typeof read) => {
      read = r;
    },
    setCommand: (w: typeof command) => {
      command = w;
    },
  };
}
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (v: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('C05 original-key ownership and shared read fence', () => {
  it('is explicitly disconnected without a real injected provider', async () => {
    const s = new EvidenceSession(target, null);
    expect(s.connected).toBe(false);
    expect(s.canEdit).toBe(false);
    expect(
      await s.bind(workspace().availablePhotos[0]!, coverage, workspace()),
    ).toEqual({ kind: 'failed', code: 'NOT_CONNECTED' });
  });
  it('sends only the allowed command shape, excluding display labels and client org/roles', async () => {
    const f = fake();
    await f.s.load();
    expect(
      await f.s.bind(f.s.data!.availablePhotos[0]!, coverage, f.s.data!),
    ).toMatchObject({ kind: 'ok' });
    expect(f.sent[0]).toEqual({
      schemaVersion: 1,
      clientMutationId: uuid(9),
      target,
      expectedRevision: 2,
      expectedBasis: null,
      operation: 'BIND',
      photo: { photoId: uuid(7), photoVersion: 3 },
      coverage,
    });
    expect(f.s.actions.owned).toBe(false);
  });
  it.each(['NETWORK', 'REQUEST_FAILED', 'RETRY', 'RATE_LIMITED'])(
    'retries %s with the exact original key and body despite later reads',
    async (code) => {
      const f = fake();
      await f.s.load();
      const edited = f.s.data!;
      f.setCommand(async (c) => {
        c.target.itemKey = 'TEST-port-mutated';
        throw new ApiError(code, 503);
      });
      expect(
        await f.s.bind(edited.availablePhotos[0]!, coverage, edited),
      ).toEqual({ kind: 'failed', code });
      const original = structuredClone(f.sent[0]);
      edited.revisionNumber = 999;
      coverage.qty = '10';
      f.setData({ ...workspace(), revisionNumber: 3 });
      await f.s.load();
      expect(f.s.canEdit).toBe(false);
      expect(await f.s.unbind(uuid(8), workspace())).toMatchObject({
        kind: 'failed',
      });
      f.setCommand(async () => ({}));
      await f.s.retry();
      expect(f.sent).toEqual([original, original]);
      expect(f.s.actions.owned).toBe(false);
    },
  );
  it('keeps ambiguity when authority is refused before replay', async () => {
    const f = fake();
    await f.s.load();
    f.setCommand(async () => {
      throw new ApiError('NETWORK', 0);
    });
    await f.s.bind(f.s.data!.availablePhotos[0]!, coverage, f.s.data!);
    expect(f.s.messageKey).toBe('fu_network');
    f.setCommand(async () => {
      throw new ApiError('FORBIDDEN', 403);
    });
    expect(await f.s.retry()).toMatchObject({
      kind: 'rejected',
      code: 'FORBIDDEN',
      uncertain: true,
    });
    expect(f.s.messageKey).toBe('fe_accessMaybeRecorded');
    expect(f.s.list.pending).toBeNull();
  });
  it('takes ownership before awaiting any write and refuses a second concurrent action', async () => {
    const f = fake();
    await f.s.load();
    const edited = f.s.data!;
    const done = deferred<unknown>();
    f.setCommand(() => done.promise);
    const writing = f.s.bind(edited.availablePhotos[0]!, coverage, edited);
    expect(f.s.actions.owned).toBe(true);
    expect(
      await f.s.bind(edited.availablePhotos[0]!, coverage, edited),
    ).toEqual({ kind: 'failed', code: 'BUSY' });
    done.resolve({});
    await writing;
    expect(f.sent).toHaveLength(1);
  });
  it.each(['revision', 'basis', 'target', 'permission'])(
    'refuses a form edited against old %s without silently rebinding or sending',
    async (change) => {
      const f = fake();
      await f.s.load();
      const edited = structuredClone(f.s.data!);
      if (change === 'revision')
        f.setData({ ...workspace(), revisionNumber: 3 });
      if (change === 'basis')
        f.setData({
          ...workspace(),
          evidence: {
            target,
            basis: { linkSetId: uuid(6), version: 1 },
            state: 'PARTIAL',
            coverage: null,
            photos: [],
          },
        });
      if (change === 'target')
        edited.target = { ...target, foremanRevisionId: uuid(20) };
      if (change === 'permission')
        f.setData({ ...workspace(), canBind: false });
      await f.s.load();
      const result = await f.s.bind(
        edited.availablePhotos[0]!,
        coverage,
        edited,
      );
      expect(result.kind).not.toBe('ok');
      expect(f.sent).toHaveLength(0);
      expect(f.s.actions.owned).toBe(false);
    },
  );
  it('handles malformed input as a definite local refusal, not an unknown network outcome', async () => {
    const f = fake();
    await f.s.load();
    expect(
      await f.s.bind(
        f.s.data!.availablePhotos[0]!,
        { ...coverage, qty: 'unknown' },
        f.s.data!,
      ),
    ).toMatchObject({
      kind: 'rejected',
      code: 'INVALID_INPUT',
      uncertain: false,
    });
    expect(f.sent).toHaveLength(0);
    expect(f.s.list.pending).toBeNull();
  });
  it('does not let older successful or failed reads overwrite a newer read', async () => {
    for (const fail of [false, true]) {
      const f = fake(),
        old = deferred<EvidenceWorkspace>();
      f.setRead(() => old.promise);
      const loading = f.s.load();
      f.setRead(async () => ({ ...workspace(), revisionNumber: 4 }));
      await f.s.load();
      if (fail) old.reject(new ApiError('FORBIDDEN', 403));
      else old.resolve(workspace());
      expect(await loading).toBe(false);
      expect(f.s.data!.revisionNumber).toBe(4);
      expect(f.s.list.readError).toBeNull();
    }
  });
  it('hides prior authorized data after access is lost and rejects a wrong-target provider response', async () => {
    const f = fake();
    await f.s.load();
    f.setRead(async () => {
      throw new ApiError('FORBIDDEN', 403);
    });
    await f.s.load();
    expect(f.s.data).toBeNull();
    expect(f.s.canEdit).toBe(false);
    f.setRead(async () => ({
      ...workspace(),
      target: { ...target, crewId: uuid(30) },
    }));
    await f.s.load();
    expect(f.s.data).toBeNull();
    expect(f.s.list.readError).toBe('NOT_FOUND');
  });
  it('requires a successful read after save, and recovery reload does not repeat a committed command', async () => {
    const f = fake();
    await f.s.load();
    f.setCommand(async () => {
      f.setRead(async () => {
        throw new ApiError('NETWORK', 0);
      });
      return {};
    });
    expect(
      await f.s.bind(f.s.data!.availablePhotos[0]!, coverage, f.s.data!),
    ).toMatchObject({ kind: 'ok' });
    expect(f.s.list.error).toBe('STALE');
    expect(f.s.canEdit).toBe(false);
    f.setRead(async () => workspace());
    await f.s.retry();
    expect(f.sent).toHaveLength(1);
    expect(f.s.canEdit).toBe(true);
  });
  it('discard rereads without sending a new mutation', async () => {
    const f = fake();
    await f.s.load();
    f.setCommand(async () => {
      throw new ApiError('NETWORK', 0);
    });
    await f.s.bind(f.s.data!.availablePhotos[0]!, coverage, f.s.data!);
    f.s.discard();
    expect(f.s.actions.owned).toBe(false);
    expect(f.s.list.pending).toBeNull();
    expect(f.sent).toHaveLength(1);
    await f.s.load();
    expect(f.s.canEdit).toBe(true);
  });
});
