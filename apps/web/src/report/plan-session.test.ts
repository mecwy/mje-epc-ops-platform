import { describe, expect, it } from 'vitest';
import type { PlanRowDto } from '@mje/contracts';
import type { PlanView } from '../api.js';
import { PlanSession } from './plan-session.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const view = (rows: PlanRowDto[]): PlanView => ({
  targetBusinessDate: 'T',
  status: { status: 'none', n: null },
  rows,
  draft: null,
  versions: [],
});
function fakeApi(initial: PlanRowDto[]) {
  const saves: { rows: PlanRowDto[]; release: () => void }[] = [];
  const confirms: PlanRowDto[][] = [];
  let server = initial;
  let confirmed: PlanRowDto[] | null = null;
  return {
    saves,
    confirms,
    api: {
      plan: async () => view(confirmed ?? server),
      savePlanDraft: (c: { rows: PlanRowDto[] }) =>
        new Promise<{ targetBusinessDate: string; status: PlanView['status'] }>(
          (resolve) =>
            saves.push({
              rows: c.rows,
              release: () => {
                server = c.rows;
                resolve({
                  targetBusinessDate: 'T',
                  status: { status: 'draft', n: null },
                });
              },
            }),
        ),
      confirmPlan: async () => {
        confirms.push(server);
        confirmed = server;
        return { targetBusinessDate: 'T', n: 1, rows: server };
      },
    },
  };
}
const row = (target: string) => [{ item: 'support', target }];

describe('plan session', () => {
  it('writes run in order: an older save can never land after a newer one', async () => {
    const f = fakeApi(row('0'));
    const s = new PlanSession(
      f.api as never,
      'p',
      'T',
      () => undefined,
      0,
      () => 'k',
    );
    await s.load();
    s.edit(row('100'));
    const first = s.save();
    await tick();
    s.edit(row('200'));
    const second = s.save();
    await tick();
    expect(f.saves).toHaveLength(1); // the second waits for the first
    f.saves[0]!.release();
    await first;
    await tick();
    expect(f.saves[1]!.rows).toEqual(row('200'));
    f.saves[1]!.release();
    await second;
  });

  it('confirm refuses edits and confirms exactly the acknowledged rows', async () => {
    const f = fakeApi(row('0'));
    const s = new PlanSession(
      f.api as never,
      'p',
      'T',
      () => undefined,
      0,
      () => 'k',
    );
    await s.load();
    s.edit(row('100'));
    const confirming = s.confirm();
    await tick();
    expect(s.confirming).toBe(true);
    expect(s.edit([])).toBe(false); // remove-all during confirmation is refused
    f.saves[0]!.release();
    await confirming;
    expect(f.confirms).toEqual([row('100')]);
    expect(s.rows).toEqual(row('100'));
  });

  it('sessions for different target dates never share rows or writes', async () => {
    const b = fakeApi(row('0'));
    const c = fakeApi(row('900'));
    const sb = new PlanSession(
      b.api as never,
      'p',
      'B',
      () => undefined,
      0,
      () => 'k',
    );
    const sc = new PlanSession(
      c.api as never,
      'p',
      'C',
      () => undefined,
      0,
      () => 'k',
    );
    await Promise.all([sb.load(), sc.load()]);
    sb.edit(row('200'));
    const pending = sb.save();
    await tick();
    b.saves[0]!.release();
    await pending;
    expect(b.saves.map((x) => x.rows)).toEqual([row('200')]);
    expect(c.saves).toHaveLength(0);
    expect(sc.rows).toEqual(row('900'));
  });
});

describe('plan session: fenced reads', () => {
  it('a read started before an edit and save never replaces the saved rows', async () => {
    let releaseRead: (v: PlanView) => void = () => undefined;
    const saves: PlanRowDto[][] = [];
    const confirms: PlanRowDto[][] = [];
    let server = row('100');
    const api = {
      plan: () => new Promise<PlanView>((r) => (releaseRead = r)),
      savePlanDraft: async (c: { rows: PlanRowDto[] }) => {
        saves.push(c.rows);
        server = c.rows;
        return {
          targetBusinessDate: 'T',
          status: { status: 'draft' as const, n: null },
        };
      },
      confirmPlan: async () => {
        confirms.push(server);
        return { targetBusinessDate: 'T', n: 1, rows: server };
      },
    };
    const s = new PlanSession(
      api as never,
      'p',
      'T',
      () => undefined,
      0,
      () => 'k',
    );
    // first load completes normally
    const first = s.load();
    releaseRead(view(row('100')));
    await first;
    // a second (remount) read is held while the user edits and the edit is saved
    const stale = s.load();
    s.edit(row('200'));
    await s.save();
    releaseRead(view(row('100')));
    await stale;
    expect(s.rows).toEqual(row('200'));
    // confirming covers exactly what is displayed
    const confirming = s.confirm();
    await tick();
    releaseRead(view(row('200')));
    await confirming;
    expect(confirms).toEqual([row('200')]);
    expect(saves).toEqual([row('200')]);
  });
});
