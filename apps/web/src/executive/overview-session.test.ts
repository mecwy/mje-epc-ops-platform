import { describe, expect, it } from 'vitest';
import type { AddStatusNoteCommand, ProjectOverviewDto } from '@mje/contracts';
import { ApiError } from '../api.js';
import {
  ProjectOverviewSession,
  type OverviewApi,
} from './overview-session.js';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function overview(projectId = A, n = 1): ProjectOverviewDto {
  return {
    projectId,
    projectCode: 'TEST-A',
    projectName: 'TEST project',
    timezone: 'Europe/Belgrade',
    statusHistory: {
      projectId,
      currentN: n,
      updates: [
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          n,
          status: 'NORMAL',
          areas: [],
          situation: '',
          recovery: '',
          expectedRecoveryDate: null,
          expectedRecoveryUnknown: false,
          needsSupport: false,
          supportNote: '',
          declaredAt: '2026-10-03T10:00:00Z',
          siteTimezone: 'Europe/Belgrade',
          businessDate: '2026-10-03',
          declaredBy: A,
          declaredByPersonId: A,
          notes: [],
        },
      ],
    },
    cumulative: [],
    primaryWorkItem: null,
    workItems: [],
    milestones: [],
    peopleLast7: [],
    openIssues: [],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function api(read = async () => overview()): OverviewApi {
  return {
    projectOverview: read,
    addProjectStatusNote: async (c) => ({
      projectId: c.projectId,
      n: c.n,
      statusUpdateId: A,
      noteId: B,
    }),
  };
}
describe('ProjectOverviewSession reply ownership and visible history', () => {
  it('rejects cross-project projections before revealing any data or allowing a reply', async () => {
    const s = new ProjectOverviewSession(
      api(async () => overview(B)),
      A,
    );
    await s.load();
    expect(s.data).toBeNull();
    expect(s.permissionLost).toBe(true);
    expect(s.locked).toBe(true);
  });
  it('does not show the old page while a new page is loading or let a late old page overwrite it', async () => {
    const old = deferred<ProjectOverviewDto>(),
      next = deferred<ProjectOverviewDto>();
    let calls = 0;
    const s = new ProjectOverviewSession(
      api(async () =>
        ++calls === 1
          ? overview(A, 21)
          : calls === 2
            ? old.promise
            : next.promise,
      ),
      A,
    );
    await s.load();
    const oldRead = s.load();
    const newRead = s.goToPage(2);
    expect(s.data).toBeNull();
    next.resolve(overview(A, 1));
    await newRead;
    old.resolve(overview(A, 21));
    await oldRead;
    expect(s.page).toBe(2);
    expect(s.data?.statusHistory.updates[0]?.n).toBe(1);
  });
  it('pins replies to the selected historical declaration and retains original text', async () => {
    const sent: AddStatusNoteCommand[] = [];
    const a = api();
    a.addProjectStatusNote = async (c) => {
      sent.push(c);
      return { projectId: A, n: c.n, statusUpdateId: B };
    };
    const s = new ProjectOverviewSession(a, A);
    await s.load();
    s.edit(1, '  TEST original text\n');
    await s.reply(1);
    expect(sent[0]).toMatchObject({
      projectId: A,
      n: 1,
      text: '  TEST original text\n',
    });
    expect(sent[0]?.clientMutationId).toMatch(/^[\da-f-]{36}$/);
    expect(s.savedN).toBe(1);
    expect(s.drafts.has(1)).toBe(false);
  });
  it('retries the exact same key/body after ambiguity despite attempted edits or page changes', async () => {
    const sent: AddStatusNoteCommand[] = [];
    const a = api();
    a.addProjectStatusNote = async (c) => {
      sent.push({ ...c });
      if (sent.length === 1) throw new ApiError('NETWORK', 0);
      return { projectId: A, n: c.n, statusUpdateId: B };
    };
    const s = new ProjectOverviewSession(a, A);
    await s.load();
    s.edit(1, 'TEST reply');
    await s.reply(1);
    expect(s.retryable).toBe(true);
    expect(s.mayBeRecorded).toBe(true);
    s.edit(1, 'changed');
    await s.goToPage(2);
    await s.reply(1);
    await s.retry();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(s.page).toBe(1);
    expect(s.savedN).toBe(1);
  });
  it('preserves the draft and possible earlier success after a retry is refused by current authority', async () => {
    let calls = 0;
    const a = api();
    a.addProjectStatusNote = async () => {
      throw new ApiError(++calls === 1 ? 'NETWORK' : 'FORBIDDEN', 403);
    };
    const s = new ProjectOverviewSession(a, A);
    await s.load();
    s.edit(1, 'TEST preserved');
    await s.reply(1);
    await s.retry();
    expect(s.mayBeRecorded).toBe(true);
    expect(s.drafts.get(1)).toBe('TEST preserved');
    expect(s.data).toBeNull();
    expect(s.permissionLost).toBe(true);
    await s.reply(1);
    expect(calls).toBe(2);
    await s.load();
    expect(s.permissionLost).toBe(false);
    expect(s.mayBeRecorded).toBe(true);
  });
  it('records acknowledged save, locks after failed rereads, and refreshes without resending', async () => {
    let fail = false,
      writes = 0;
    const a = api(async () => {
      if (fail) throw new ApiError('NETWORK', 0);
      return overview();
    });
    a.addProjectStatusNote = async (c) => {
      writes++;
      fail = true;
      return { projectId: A, n: c.n, statusUpdateId: B };
    };
    const s = new ProjectOverviewSession(a, A);
    await s.load();
    s.edit(1, 'TEST save');
    await s.reply(1);
    expect(s.savedN).toBe(1);
    expect(s.savedNeedsRefresh).toBe(true);
    expect(s.locked).toBe(true);
    expect(s.retryable).toBe(false);
    await s.retry();
    await s.reply(1);
    expect(writes).toBe(1);
    fail = false;
    await s.load();
    expect(s.locked).toBe(false);
    expect(writes).toBe(1);
  });
  it('prevents double submits and abandonment while an actual send is still running', async () => {
    let writes = 0;
    const held = deferred<{
      projectId: string;
      n: number;
      statusUpdateId: string;
    }>();
    const a = api();
    a.addProjectStatusNote = () => {
      writes++;
      return held.promise;
    };
    const s = new ProjectOverviewSession(a, A);
    await s.load();
    s.edit(1, 'TEST pending');
    const first = s.reply(1);
    await Promise.resolve();
    await Promise.resolve();
    await s.reply(1);
    s.discard();
    expect(s.commands.owned).toBe(true);
    expect(s.retryable).toBe(false);
    held.resolve({ projectId: A, n: 1, statusUpdateId: B });
    await first;
    expect(writes).toBe(1);
  });
  it('keeps abandoned ambiguous text and its uncertainty without sending another command', async () => {
    let writes = 0;
    const a = api();
    a.addProjectStatusNote = async () => {
      writes++;
      throw new ApiError('NETWORK', 0);
    };
    const s = new ProjectOverviewSession(a, A);
    await s.load();
    s.edit(1, 'TEST unknown');
    await s.reply(1);
    s.discard();
    expect(s.retryable).toBe(false);
    expect(s.mayBeRecorded).toBe(true);
    expect(s.drafts.get(1)).toBe('TEST unknown');
    expect(writes).toBe(1);
  });
  it('does not send empty, oversized or invisible-target replies', async () => {
    let writes = 0;
    const a = api();
    a.addProjectStatusNote = async (c) => {
      writes++;
      return { projectId: A, n: c.n, statusUpdateId: B };
    };
    const s = new ProjectOverviewSession(a, A);
    await s.load();
    s.edit(1, ' ');
    await s.reply(1);
    s.edit(1, 'x'.repeat(4001));
    await s.reply(1);
    s.edit(2, 'TEST wrong target');
    await s.reply(2);
    expect(writes).toBe(0);
  });
  it('keeps project sessions independent when the visible project changes', async () => {
    const sent: AddStatusNoteCommand[] = [];
    const a: OverviewApi = {
      projectOverview: async (id) => overview(id),
      addProjectStatusNote: async (c) => {
        sent.push(c);
        throw new ApiError('NETWORK', 0);
      },
    };
    const first = new ProjectOverviewSession(a, A),
      second = new ProjectOverviewSession(a, B);
    await first.load();
    await second.load();
    first.edit(1, 'TEST A');
    await first.reply(1);
    second.edit(1, 'TEST B');
    await second.reply(1);
    await first.retry();
    expect(sent.map((c) => c.projectId)).toEqual([A, B, A]);
    expect(sent[2]).toEqual(sent[0]);
    expect(sent[1]?.clientMutationId).not.toBe(sent[0]?.clientMutationId);
  });
});
