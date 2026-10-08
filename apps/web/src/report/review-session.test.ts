/** Synthetic TEST services only; no API, database, login or browser acceptance. */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api.js';
import {
  ManagerReviewSession,
  reviewCanAct,
  visibleReviewState,
  type ManagerReviewRead,
  type ReviewInput,
} from './review-session.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const target = {
  projectId: id(1),
  businessDate: '2026-10-05',
  crewId: id(2),
  foremanRevisionId: id(3),
  itemKey: 'TEST_work',
};
const basis = { linkSetId: id(4), version: 1 };
const dto = (): ManagerReviewRead => ({
  actorScopeKey: 'TEST_actor_A',
  target: { ...target },
  revisionNumber: 1,
  reviewVersion: 0,
  declaredQty: '100',
  labels: { crew: 'TEST crew', item: 'TEST work', scope: 'TEST scope' },
  unit: 'TEST_unit',
  scopeRef: id(5),
  capability: {
    basisRef: id(6),
    actions: ['RETURN', 'INCONCLUSIVE', 'CONFIRM_SCOPE'],
  },
  evidence: {
    target: { ...target },
    basis: { ...basis },
    state: 'READY',
    coverage: {
      scopeRef: id(5),
      withinScopeRef: id(5),
      qty: '100',
      unit: 'TEST_unit',
    },
    photos: [{ photoId: id(7), photoVersion: 1, linkId: id(8) }],
  },
  state: {
    target: { ...target },
    status: 'NOT_CHECKED',
    coverage: 'NONE',
    confirmedQty: null,
    unit: null,
    eventId: null,
    reviewVersion: 0,
  },
  judgment: null,
});
const input = (): ReviewInput => ({
  target: { ...target },
  expectedRevision: 1,
  expectedVersion: 0,
  decision: 'RETURN',
  coverage: null,
  evidenceBasis: { ...basis },
  reason: 'TEST correction',
  method: '',
  limitations: '',
});
const tick = () => new Promise((r) => setTimeout(r, 0));
function rig() {
  let data = dto();
  let failReads = false;
  let holdReads = false;
  let failRelease = false;
  let lock: string | null = null;
  let holdWrite: (() => void) | null = null;
  let prepareResult: 'ok' | 'blocked' | 'unknown' = 'ok';
  let holdPrepare = false;
  let prepared: (() => void) | null = null;
  const reads: (() => void)[] = [];
  const plans: string[] = [];
  const writes: string[] = [];
  const releases: string[] = [];
  const stored = new Map<string, string>();
  let key = 10;
  const session = new ManagerReviewSession(
    target,
    'TEST_actor_A',
    {
      read: async () => {
        const captured = structuredClone(data);
        if (holdReads)
          await new Promise<void>((resolve) => reads.push(resolve));
        if (failReads) throw new ApiError('NETWORK', 0);
        return captured;
      },
      write: async (command) => {
        const body = JSON.stringify(command);
        writes.push(body);
        const plan = plans.shift() ?? 'OK';
        if (plan === 'FORBIDDEN') throw new ApiError('FORBIDDEN', 403);
        if (plan === 'RATE_LIMITED') throw new ApiError('RATE_LIMITED', 429);
        const prior = stored.get(command.clientMutationId);
        if (prior && prior !== body)
          throw new ApiError('IDEMPOTENCY_KEY_REUSED', 409);
        if (!prior) {
          stored.set(command.clientMutationId, body);
          data = {
            ...data,
            reviewVersion: data.reviewVersion + 1,
            state: {
              ...data.state,
              reviewVersion: data.reviewVersion + 1,
              status: 'RETURNED',
              eventId: id(9),
            },
          };
        }
        if (plan === 'HOLD')
          await new Promise<void>((resolve) => {
            holdWrite = resolve;
          });
        if (plan === 'NETWORK') throw new ApiError('NETWORK', 0);
      },
    },
    {
      holds: (owner) => lock === owner,
      acquire: (owner) => {
        if (lock && lock !== owner) return false;
        lock = owner;
        return true;
      },
      prepare: async () => {
        if (holdPrepare)
          await new Promise<void>((resolve) => {
            prepared = resolve;
          });
        return prepareResult;
      },
      abandon: (owner) => {
        if (lock === owner) lock = null;
      },
      release: async (owner, outcome) => {
        releases.push(outcome);
        if (failRelease || lock !== owner) return false;
        lock = null;
        return true;
      },
    },
    () => id(key++),
  );
  return {
    session,
    writes,
    releases,
    plans,
    reads,
    stored,
    get data() {
      return data;
    },
    get lock() {
      return lock;
    },
    setData: (next: ManagerReviewRead) => {
      data = next;
    },
    failReads: (v: boolean) => {
      failReads = v;
    },
    holdReads: (v: boolean) => {
      holdReads = v;
    },
    failRelease: (v: boolean) => {
      failRelease = v;
    },
    occupy: () => {
      lock = 'TEST_other_action';
    },
    reloadRelease: () => {
      lock = null;
    },
    finishWrite: () => holdWrite?.(),
    prepareResult: (v: 'ok' | 'blocked' | 'unknown') => {
      prepareResult = v;
    },
    holdPrepare: () => {
      holdPrepare = true;
    },
    finishPrepare: () => prepared?.(),
  };
}

describe('C04 review ownership, replay and shared day-lock port (CG-I04/05)', () => {
  it('uses canonical lock ownership after an external successful day reload', async () => {
    const r = rig();
    await r.session.load();
    r.failRelease(true);
    await r.session.start(input());
    expect(r.session.held).toBe(true);
    r.reloadRelease();
    expect(r.session.held).toBe(false);
    expect(r.session.canStart).toBe(true);
    expect(await r.session.refresh()).toBe(true);
    expect(r.session.lockOutcome).toBeNull();
  });
  it('does not discard an unresolved original command when canonical lock ownership changes', async () => {
    const r = rig();
    await r.session.load();
    r.plans.push('NETWORK');
    await r.session.start(input());
    const original = r.session.owned.current;
    r.reloadRelease();
    expect(r.session.held).toBe(false);
    expect(r.session.canStart).toBe(false);
    expect(r.session.owned.current).toBe(original);
    expect(r.session.owned.unresolved).not.toBeNull();
  });
  it('claims synchronously, exposes immutable original input and rejects a competing action', async () => {
    const r = rig();
    await r.session.load();
    r.plans.push('HOLD');
    const v = input();
    const first = r.session.start(v);
    expect(r.session.owned.current?.command.reason).toBe('TEST correction');
    v.reason = 'TEST later edit';
    expect(r.session.owned.current?.command.reason).toBe('TEST correction');
    expect(await r.session.start(input())).toMatchObject({
      kind: 'rejected',
      code: 'BUSY',
    });
    await tick();
    r.finishWrite();
    expect(await first).toMatchObject({ kind: 'ok' });
    expect(r.writes).toHaveLength(1);
    expect(r.lock).toBeNull();
  });

  it('a committed response loss retries the same bytes/key and does not create a second event', async () => {
    const r = rig();
    await r.session.load();
    r.plans.push('NETWORK');
    expect(await r.session.start(input())).toMatchObject({
      kind: 'failed',
      code: 'NETWORK',
    });
    expect(r.lock).not.toBeNull();
    expect(r.session.owned.unresolved).not.toBeNull();
    await r.session.load(); // newer review version must not rebind a pending original command
    expect(await r.session.retry()).toMatchObject({ kind: 'ok' });
    expect(r.writes[1]).toBe(r.writes[0]);
    expect(r.stored.size).toBe(1);
    expect(r.session.owned.current).toBeNull();
    expect(r.lock).toBeNull();
  });

  it('revoked scope retains pending payload; explicit retry reports that its prior attempt may be recorded', async () => {
    const r = rig();
    await r.session.load();
    r.plans.push('NETWORK');
    await r.session.start(input());
    r.setData({ ...r.data, capability: { basisRef: null, actions: [] } });
    await r.session.load();
    r.plans.push('FORBIDDEN');
    expect(r.session.owned.current).not.toBeNull();
    expect(await r.session.retry()).toMatchObject({
      kind: 'rejected',
      code: 'FORBIDDEN',
      uncertain: true,
    });
    expect(r.session.owned.refusalUncertain).toBe(true);
    expect(r.releases).toEqual(['unknown']);
    expect(r.writes[1]).toBe(r.writes[0]);
  });

  it('account switching cannot send the original command under another account', async () => {
    const r = rig();
    await r.session.load();
    r.plans.push('NETWORK');
    await r.session.start(input());
    r.session.setActor('TEST_actor_B');
    expect(await r.session.retry()).toMatchObject({ code: 'ACTOR_CHANGED' });
    expect(r.writes).toHaveLength(1);
    expect(r.session.owned.current).not.toBeNull();
    await r.session.discard();
    expect(r.releases).toEqual(['unknown']);
  });

  it('another day mutation lock prevents a send and does not become this action ownership', async () => {
    const r = rig();
    await r.session.load();
    r.occupy();
    expect(await r.session.start(input())).toMatchObject({ code: 'BUSY' });
    expect(r.writes).toHaveLength(0);
    expect(r.session.owned.current).toBeNull();
  });

  it('the owned payload waits for existing draft preparation, then refuses an account switch without writing', async () => {
    const r = rig();
    await r.session.load();
    r.holdPrepare();
    const result = r.session.start(input());
    await tick();
    expect(r.writes).toHaveLength(0);
    expect(r.session.owned.current).not.toBeNull();
    r.session.setActor('TEST_actor_B');
    r.finishPrepare();
    expect(await result).toMatchObject({
      kind: 'rejected',
      code: 'ACTOR_CHANGED',
    });
    expect(r.writes).toHaveLength(0);
  });

  it('unknown pre-save keeps the original review pending; explicit retry prepares again before writing', async () => {
    const r = rig();
    await r.session.load();
    r.prepareResult('unknown');
    expect(await r.session.start(input())).toMatchObject({ kind: 'failed' });
    expect(r.writes).toHaveLength(0);
    expect(r.lock).not.toBeNull();
    const key = r.session.owned.current!.command.clientMutationId;
    r.prepareResult('ok');
    await r.session.retry();
    expect(JSON.parse(r.writes[0]!).clientMutationId).toBe(key);
  });

  it.each(['saved', 'unknown'] as const)(
    'failed post-write day read keeps the lock with %s wording until refresh',
    async (mode) => {
      const r = rig();
      await r.session.load();
      r.failRelease(true);
      if (mode === 'unknown') {
        r.plans.push('NETWORK');
        await r.session.start(input());
        await r.session.discard();
      } else await r.session.start(input());
      expect(r.session.held).toBe(true);
      expect(r.session.canStart).toBe(false);
      expect(r.session.lockOutcome).toBe(mode);
      r.failRelease(false);
      await r.session.refresh();
      expect(r.session.held).toBe(false);
    },
  );

  it('a failed review read blocks new judgments even if the day read succeeded', async () => {
    const r = rig();
    await r.session.load();
    r.failReads(true);
    await r.session.start(input());
    expect(r.session.canStart).toBe(false);
    expect(r.session.data).toBeNull();
    r.failReads(false);
    await r.session.refresh();
    expect(r.session.canStart).toBe(true);
  });

  it('a stale read cannot replace a newer review cut', async () => {
    const r = rig();
    await r.session.load();
    r.holdReads(true);
    const old = r.session.load();
    const next = {
      ...r.data,
      declaredQty: 'TEST newest',
      target: { ...target, foremanRevisionId: id(30) },
      revisionNumber: 2,
    };
    next.state = { ...next.state, target: next.target };
    r.setData(next);
    const newer = r.session.load();
    r.reads[1]!();
    await newer;
    r.reads[0]!();
    await old;
    expect(r.session.data?.declaredQty).toBe('TEST newest');
  });

  it.each(['project', 'day', 'crew', 'item', 'actor'] as const)(
    'a mismatched authorized read (%s) never supplies a command basis',
    async (field) => {
      const r = rig();
      const d = dto();
      if (field === 'actor') d.actorScopeKey = 'TEST_actor_B';
      else if (field === 'project') d.target.projectId = id(30);
      else if (field === 'day') d.target.businessDate = '2026-10-04';
      else if (field === 'crew') d.target.crewId = id(30);
      else d.target.itemKey = 'TEST_other';
      r.setData(d);
      expect(await r.session.load()).toBe(false);
      expect(await r.session.start(input())).toMatchObject({ code: 'STALE' });
      expect(r.writes).toHaveLength(0);
    },
  );

  it.each(['revision', 'review', 'evidence'] as const)(
    'the preview captured an obsolete %s; it is rejected locally without sending or leaking the day lock',
    async (kind) => {
      const r = rig();
      await r.session.load();
      const old = input();
      const d = dto();
      if (kind === 'revision') {
        d.target.foremanRevisionId = id(30);
        d.state.target = { ...d.target };
        d.revisionNumber = 2;
      }
      if (kind === 'review') {
        d.reviewVersion = 1;
        d.state.reviewVersion = 1;
      }
      if (kind === 'evidence') d.evidence!.basis.version = 2;
      r.setData(d);
      await r.session.load();
      expect(await r.session.start(old)).toMatchObject({
        kind: 'rejected',
        code:
          kind === 'revision'
            ? 'FOREMAN_REVISION_CHANGED'
            : kind === 'review'
              ? 'REVIEW_VERSION_CONFLICT'
              : 'EVIDENCE_CHANGED',
      });
      expect(r.writes).toHaveLength(0);
      expect(r.lock).toBeNull();
    },
  );

  it('a RATE_LIMITED retry keeps the key and allows no second action', async () => {
    const r = rig();
    await r.session.load();
    r.plans.push('RATE_LIMITED');
    await r.session.start(input());
    expect(await r.session.start(input())).toMatchObject({ code: 'BUSY' });
    await r.session.retry();
    expect(r.writes[1]).toBe(r.writes[0]);
  });
});

describe('C04 capability and judgment projection (CG-I01/02/03)', () => {
  it('job title and canWrite do not supply a missing explicit capability', () => {
    const d = {
      ...dto(),
      role: 'PROJECT_MANAGER',
      canWrite: true,
      capability: { basisRef: null, actions: [] },
    };
    expect(reviewCanAct(d, 'RETURN')).toBe(false);
    expect(reviewCanAct(d, 'CONFIRM_SCOPE')).toBe(false);
  });
  it.each([
    'missing',
    'unconfirmed',
    'wrong target',
    'no photo',
    'zero photo version',
    'wrong unit',
  ] as const)(
    '%s evidence cannot enable scope confirmation but permits an authorized return',
    (kind) => {
      const d = dto();
      if (kind === 'missing') d.evidence = null;
      if (kind === 'unconfirmed') d.evidence!.state = 'UNCONFIRMED_SCOPE';
      if (kind === 'wrong target')
        d.evidence!.target.foremanRevisionId = id(30);
      if (kind === 'no photo') d.evidence!.photos = [];
      if (kind === 'zero photo version')
        d.evidence!.photos = [
          { photoId: id(7), photoVersion: 0, linkId: id(8) },
        ];
      if (kind === 'wrong unit') d.evidence!.coverage!.unit = 'TEST_other';
      expect(reviewCanAct(d, 'CONFIRM_SCOPE')).toBe(false);
      expect(reviewCanAct(d, 'RETURN')).toBe(true);
    },
  );
  it('READY evidence is not a server confirmation', () => {
    expect(visibleReviewState(dto()).status).toBe('NOT_CHECKED');
  });
  it('an old judgment cannot confirm a new evidence association cut', () => {
    const d = dto();
    d.reviewVersion = 1;
    d.state = {
      ...d.state,
      reviewVersion: 1,
      status: 'CONFIRMED_SCOPE',
      coverage: 'FULL',
      confirmedQty: '100',
      unit: d.unit,
      eventId: id(9),
    };
    d.judgment = {
      id: id(9),
      target: { ...target },
      version: 1,
      decision: 'CONFIRM_SCOPE',
      confirmedQty: '100',
      scopeRef: id(5),
      unit: d.unit,
      evidenceBasis: { ...basis },
      reason: '',
      method: 'TEST observation',
      limitations: '',
    };
    expect(visibleReviewState(d).status).toBe('CONFIRMED_SCOPE');
    d.evidence!.basis.version = 2;
    expect(visibleReviewState(d)).toMatchObject({
      status: 'REVIEW_REQUIRED',
      confirmedQty: null,
    });
    expect(d.state.confirmedQty).toBe('100'); // never rewrite server history
  });
});
