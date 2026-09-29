import { describe, expect, it } from 'vitest';
import { ApiError, type IssueItem, type IssueList } from '../api.js';
import { IssueSession } from './issue-session.js';

const issue = (id: string, version: number): IssueItem => ({
  id,
  title: `TEST ${id}`,
  category: '',
  escalate: false,
  controlled: false,
  ownerPersonId: null,
  dueOn: null,
  workItemKey: null,
  status: 'open',
  closedToday: false,
  last: null,
  createdOn: '2026-10-01',
  closedOn: null,
  state: 'OPEN',
  version,
  notes: [],
});
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A fake API whose writes the test settles one by one. */
function fake(listFor: (date: string) => IssueItem[]) {
  const writes: {
    kind: string;
    command: Record<string, unknown>;
    settle: (e?: Error) => void;
  }[] = [];
  const write = (kind: string) => (command: Record<string, unknown>) =>
    new Promise((resolve, reject) =>
      writes.push({
        kind,
        command,
        settle: (e) => (e ? reject(e) : resolve({})),
      }),
    );
  const api = {
    issues: async (_p: string, date: string): Promise<IssueList> => ({
      access: 'write',
      projectId: 'p',
      businessDate: date,
      issues: listFor(date),
    }),
    lag: async (_p: string, date: string) => ({
      projectId: 'p',
      businessDate: date,
      suggestions: [],
    }),
    createIssue: write('create'),
    noteIssue: write('note'),
    escalateIssue: write('escalate'),
    closeIssue: write('close'),
    reopenIssue: write('reopen'),
    replyIssue: write('reply'),
    dismissLag: write('dismissLag'),
  };
  return { api, writes };
}
let n = 0;
const session = (api: unknown, date: string) =>
  new IssueSession(
    api as never,
    'p',
    date,
    () => undefined,
    () => `k${++n}`,
  );

describe('issue session', () => {
  it('builds a queued action with the version current when it runs', async () => {
    let version = 3;
    const f = fake(() => [issue('i1', version)]);
    const s = session(f.api, 'A');
    await s.load();
    const first = s.note('i1', 'one');
    const second = s.close('i1');
    await tick();
    expect(f.writes[0]!.command['expectedVersion']).toBe(3);
    version = 4; // the note bumps the version; the reload after it sees 4
    f.writes[0]!.settle();
    await first;
    await tick();
    expect(f.writes[1]!.kind).toBe('close');
    expect(f.writes[1]!.command['expectedVersion']).toBe(4);
    f.writes[1]!.settle();
    await second;
  });

  it('refuses an action on an issue that is not loaded instead of guessing a version', async () => {
    const f = fake(() => []);
    const s = session(f.api, 'A');
    await s.load();
    expect(await s.close('missing')).toBe('rejected');
    expect(s.error).toBe('NOT_FOUND');
    expect(f.writes).toHaveLength(0);
  });

  it('sessions for two days never share issues, versions or writes', async () => {
    const f = fake((date) =>
      date === 'A' ? [issue('a', 1)] : [issue('b', 7)],
    );
    const a = session(f.api, 'A');
    const b = session(f.api, 'B');
    await Promise.all([a.load(), b.load()]);
    const pending = a.note('a', 'x');
    await tick();
    await b.load();
    f.writes[0]!.settle();
    await pending;
    expect(a.issues?.map((i) => i.id)).toEqual(['a']);
    expect(b.issues?.map((i) => i.id)).toEqual(['b']);
    const onB = b.close('b');
    await tick();
    expect(f.writes[1]!.command['expectedVersion']).toBe(7);
    expect(f.writes[1]!.command['businessDate']).toBe('B');
    f.writes[1]!.settle();
    await onB;
  });

  it('a create whose response was lost is retried unchanged, never as a second issue', async () => {
    const f = fake(() => []);
    const s = session(f.api, 'A');
    await s.load();
    const first = s.create({
      title: 'TEST',
      category: '',
      escalate: false,
      controlled: false,
      workItemKey: null,
      dueOn: null,
      note: '',
    });
    await tick();
    f.writes[0]!.settle(new ApiError('NETWORK', 0));
    expect(await first).toBe('failed');
    expect(s.pending?.kind).toBe('create');
    // a new action is refused until the unresolved one is retried
    expect(await s.dismissLag('support')).toBe('failed');
    expect(f.writes).toHaveLength(1);
    const retry = s.retry();
    await tick();
    expect(f.writes[1]!.command['clientMutationId']).toBe(
      f.writes[0]!.command['clientMutationId'],
    );
    f.writes[1]!.settle();
    expect(await retry).toBe('ok');
    expect(s.pending).toBeNull();
  });

  it('a definite rejection is reported with its code and not retried', async () => {
    const f = fake(() => [issue('i1', 1)]);
    const s = session(f.api, 'A');
    await s.load();
    const r = s.close('i1');
    await tick();
    f.writes[0]!.settle(new ApiError('DATE_BEFORE_REOPEN', 409));
    expect(await r).toBe('rejected');
    expect(s.error).toBe('DATE_BEFORE_REOPEN');
    expect(s.pending).toBeNull();
  });

  it('a refresh superseded by another read does not release the next action early', async () => {
    const f = fake(() => []);
    let version = 3;
    let failReads = false;
    const reads: { resolve: () => void; version: number }[] = [];
    const api = {
      ...f.api,
      // Each read captures the version when it starts; the test decides when it lands.
      issues: (_p: string, date: string) => {
        const at = version;
        return new Promise<IssueList>((resolve, reject) =>
          reads.push({
            version: at,
            resolve: () =>
              failReads
                ? reject(new ApiError('NETWORK', 0))
                : resolve({
                    access: 'write',
                    projectId: 'p',
                    businessDate: date,
                    issues: [issue('i1', at)],
                  }),
          }),
        );
      },
    };
    const s = session(api, 'A');
    const first = s.load();
    reads[0]!.resolve();
    await first;
    const note = s.note('i1', 'one');
    const close = s.close('i1');
    await tick();
    version = 4;
    f.writes[0]!.settle();
    await tick();
    // The note's refresh (read 1) is superseded by a concurrent load (read 2) that has not
    // landed when the refresh returns.
    const other = s.load();
    await tick();
    reads[1]!.resolve();
    await note;
    await tick();
    reads[2]!.resolve();
    await other;
    await tick();
    expect(f.writes[1]!.kind).toBe('close');
    expect(f.writes[1]!.command['expectedVersion']).toBe(4);
    f.writes[1]!.settle();
    // Its refresh fails every time: the next action is not sent with an old version.
    version = 5;
    failReads = true;
    const pending = close;
    for (let i = 0; i < 3; i++) {
      await tick();
      reads.at(-1)!.resolve();
    }
    expect(await pending).toBe('ok');
    expect(s.error).toBe('SAVED_STALE');
    const next = s.reopen('i1');
    for (let i = 0; i < 3; i++) {
      await tick();
      reads.at(-1)!.resolve();
    }
    expect(await next).toBe('failed');
    expect(s.error).toBe('STALE'); // this one was not sent
    expect(f.writes).toHaveLength(2);
    expect(s.needsRetry).toBe(true);
    failReads = false;
    const retry = s.retry();
    await tick();
    reads.at(-1)!.resolve();
    expect(await retry).toBe('ok');
    expect(s.error).toBeNull();
    expect(s.issues?.[0]?.version).toBe(5);
  });

  it('a conflict says "reloaded" only when the reload landed', async () => {
    let fail = false;
    const f = fake(() => {
      if (fail) throw new ApiError('NETWORK', 0);
      return [issue('i1', 1)];
    });
    const s = session(f.api, 'A');
    await s.load();
    const r = s.close('i1');
    await tick();
    fail = true;
    f.writes[0]!.settle(new ApiError('VERSION_CONFLICT', 409));
    expect(await r).toBe('rejected');
    expect(s.error).toBe('CONFLICT_STALE');
    expect(s.needsRetry).toBe(true);
    fail = false;
    expect(await s.retry()).toBe('ok');
    expect(s.error).toBeNull();
  });
});
