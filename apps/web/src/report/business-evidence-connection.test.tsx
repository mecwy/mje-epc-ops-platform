import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  BusinessEvidenceCommand,
  EvidenceWorkspace,
  ManagerReviewReadDto,
  ReviewForemanCommand,
  SaveFactsCommand,
} from '@mje/contracts';
import { ApiError, type DayView } from '../api.js';
import { DayStore, emptyFacts } from './day-store.js';
import { I18nProvider } from '../i18n.js';
import {
  BusinessEvidenceContext,
  BusinessEvidenceConnection,
  FieldEvidenceRecovery,
  FieldEvidenceWorkspace,
  fieldEvidenceServices,
  managerReviewDayLock,
} from './business-evidence-connection.js';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = `${id(2)}:${id(3)}`;
const target = {
  projectId: id(4),
  businessDate: '2026-10-06',
  crewId: id(5),
  foremanRevisionId: id(6),
  itemKey: 'TEST_WORK',
};
const coverage = {
  scopeRef: id(7),
  withinScopeRef: id(7),
  qty: '10',
  unit: 'TEST_m',
};
function day(version = 1): DayView {
  return {
    projectId: target.projectId,
    businessDate: target.businessDate,
    siteTimezone: 'Europe/Belgrade',
    facts: {
      ...emptyFacts(),
      weather: 'TEST_weather',
      siteLocation: 'TEST_address',
      temperature: '26',
      people: { TEST_crew: '8' },
    },
    state: 'draft',
    version,
    currentRevisionNumber: 0,
    access: 'write',
    items: [],
    baseline: null,
    nextPlan: { status: 'missing', n: null, rows: [] },
    previousSubmittedDate: null,
    cumulativeBase: {},
    materialsCumulative: {},
    coverage: { missing: [], warnings: [] },
    photos: [],
    unlinkedPhotos: 0,
    correctionReason: null,
    planStatus: { status: 'missing', n: null, confirmedAt: null },
    revisions: [],
  } as unknown as DayView;
}
function evidence(): EvidenceWorkspace {
  return {
    target,
    revisionNumber: 1,
    declaration: {
      qty: '10',
      unit: coverage.unit,
      scopeRef: coverage.scopeRef,
    },
    evidence: null,
    associationCoverage: null,
    availablePhotos: [{ photoId: id(8), photoVersion: 1, label: 'TEST photo' }],
    scopes: [
      {
        id: coverage.scopeRef,
        withinScopeRef: coverage.scopeRef,
        label: 'TEST scope',
      },
    ],
    history: [],
    canBind: true,
  };
}
function setup(canonical = false) {
  const api = {
    day: vi.fn(async () => day()),
    revision: vi.fn(),
    saveFacts: vi.fn(async (command: SaveFactsCommand) => ({
      version: 2,
      state: 'draft' as const,
      businessDate: command.businessDate,
    })),
  };
  const write = vi.fn(
    async (command: BusinessEvidenceCommand): Promise<unknown> => ({
      target: command.target,
    }),
  );
  const owner = new FieldEvidenceWorkspace();
  const services = {
    review: {
      read: vi.fn(async (): Promise<ManagerReviewReadDto> => {
        throw new ApiError('FORBIDDEN', 403);
      }),
      write: vi.fn<(command: ReviewForemanCommand) => Promise<void>>(
        async () => {},
      ),
    },
    evidence: { read: vi.fn(async () => evidence()), command: write },
  };
  owner.bind(actor, services);
  const store = canonical
    ? owner.dayStoreFor(actor, target.projectId, api)
    : new DayStore(api, () => {});
  const entry = store.entry(target.projectId, target.businessDate);
  owner.dayStore(target.projectId, store);
  const claim = owner.claim(actor, target);
  const bind = () =>
    claim.evidence.bind(evidence().availablePhotos[0]!, coverage, evidence());
  return { api, store, entry, write, owner, services, claim, bind };
}
describe('actual shared day store integration', () => {
  it('renders the actual en-GB evidence card without mocking React state', () => {
    const f = setup();
    vi.stubGlobal('localStorage', { getItem: () => 'en' });
    vi.stubGlobal('navigator', { languages: ['en-GB'] });
    try {
      const html = renderToStaticMarkup(
        createElement(
          I18nProvider,
          null,
          createElement(
            BusinessEvidenceContext.Provider,
            {
              value: {
                owner: f.owner,
                actor,
                projectId: target.projectId,
                businessDate: target.businessDate,
              },
            },
            createElement(BusinessEvidenceConnection, target),
          ),
        ),
      );
      expect(html).toContain('Quantity evidence');
      expect(html).not.toContain('工程量证据');
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('shows submitted evidence unavailable without creating a live claim or retry', () => {
    const f = setup();
    const claim = vi.spyOn(f.owner, 'claim');
    vi.stubGlobal('localStorage', { getItem: () => 'en' });
    vi.stubGlobal('navigator', { languages: ['en-GB'] });
    try {
      const html = renderToStaticMarkup(
        createElement(
          I18nProvider,
          null,
          createElement(
            BusinessEvidenceContext.Provider,
            {
              value: {
                owner: f.owner,
                actor,
                projectId: target.projectId,
                businessDate: target.businessDate,
                submitted: true,
              },
            },
            createElement(BusinessEvidenceConnection, target),
          ),
        ),
      );
      expect(html).toContain('Submitted evidence unavailable');
      expect(html).not.toContain('Retry');
      expect(claim).not.toHaveBeenCalled();
      expect(f.services.evidence.read).not.toHaveBeenCalled();
      expect(f.services.review.read).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('keeps an unresolved original claim reachable after a new revision and another day', async () => {
    const f = setup();
    await f.store.read(f.entry, false);
    await f.claim.evidence.load();
    f.write.mockRejectedValueOnce(new ApiError('NETWORK', 503));
    await f.bind();
    const original = structuredClone(f.write.mock.calls[0]![0]);
    f.owner.claim(actor, { ...target, foremanRevisionId: id(20) });
    f.owner.claim(actor, {
      ...target,
      businessDate: '2026-10-07',
      foremanRevisionId: id(21),
    });
    const rows = f.owner.recoveries(actor);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target).toEqual(target);
    await rows[0]!.retry();
    expect(f.write.mock.calls.map(([c]) => c)).toEqual([original, original]);
    expect(f.entry.lock).toBeNull();
  });
  it('does not create a substitute transport when real HTTP methods are missing', () => {
    expect(fieldEvidenceServices({})).toBeNull();
  });
  it('keeps core report saving available without registering an unverified evidence owner', async () => {
    const f = setup();
    const owner = new FieldEvidenceWorkspace();
    expect(fieldEvidenceServices({})).toBeNull();
    expect(() => owner.dayStore(target.projectId, f.store)).not.toThrow();
    await f.store.read(f.entry, false);
    f.store.edit(f.entry, 'weather', 'TEST fallback weather');
    expect(await f.store.flush(f.entry)).toBe('ok');
    expect(f.entry.session.facts).toMatchObject({
      weather: 'TEST fallback weather',
      siteLocation: 'TEST_address',
      temperature: '26',
      people: { TEST_crew: '8' },
    });
    owner.bind(actor, f.services);
    expect(() => owner.claim(actor, target)).toThrowError('NOT_CONNECTED');
    expect(f.services.evidence.read).not.toHaveBeenCalled();
  });
  it('renders workspace Retry/Give up after the crew line is removed, without business payload', async () => {
    const f = setup();
    await f.store.read(f.entry, false);
    await f.claim.evidence.load();
    f.write.mockRejectedValueOnce(new ApiError('NETWORK', 503));
    await f.bind();
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(FieldEvidenceRecovery, {
          owner: f.owner,
          actor,
          projectLabel: () => 'TEST project',
        }),
      ),
    );
    expect(html).toContain('TEST project');
    expect(html).toContain(target.businessDate);
    expect(html).toMatch(/重试|Retry/);
    expect(html).toMatch(/不再重试|Give up/);
    expect(html).not.toContain(target.foremanRevisionId);
    expect(html).not.toContain(coverage.unit);
    f.owner.clearActor();
    expect(f.owner.recoveries(actor)).toEqual([]);
  });
  it('giving up an orphaned photo write rereads its original day before unlocking', async () => {
    const f = setup();
    await f.store.read(f.entry, false);
    await f.claim.evidence.load();
    f.write.mockRejectedValueOnce(new ApiError('NETWORK', 503));
    await f.bind();
    f.owner.claim(actor, { ...target, foremanRevisionId: id(20) });
    f.api.day.mockRejectedValueOnce(new ApiError('NETWORK', 503));
    f.owner.recoveries(actor)[0]!.discard();
    await vi.waitFor(() => expect(f.entry.stale).toBe(true));
    const row = f.owner.recoveries(actor)[0]!;
    expect(row.unresolved).toBe(false);
    expect(row.held).toBe(true);
    expect(f.store.acquire(f.entry, 'TEST_submit')).toBe(false);
    await row.refresh();
    expect(f.entry.lock).toBeNull();
    expect(f.owner.recoveries(actor)).toEqual([]);
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it('retains original review retry after a new declaration replaces its visible row', async () => {
    const f = setup();
    await f.store.read(f.entry, false);
    const read: ManagerReviewReadDto = {
      actorScopeKey: `${id(1)}:${actor}`,
      target,
      revisionNumber: 1,
      reviewVersion: 0,
      declaredQty: '10',
      labels: { crew: 'TEST crew', item: 'TEST work', scope: null },
      unit: coverage.unit,
      scopeRef: coverage.scopeRef,
      capability: { basisRef: id(9), actions: ['RETURN'] },
      evidence: null,
      state: {
        target,
        status: 'NOT_CHECKED',
        coverage: 'NONE',
        confirmedQty: null,
        unit: null,
        eventId: null,
        reviewVersion: 0,
      },
      judgment: null,
    };
    f.services.review.read.mockResolvedValue(read);
    await f.claim.loadReview();
    const review = f.claim.review!;
    f.services.review.write.mockRejectedValueOnce(new ApiError('NETWORK', 503));
    await review.start({
      target,
      expectedRevision: 1,
      expectedVersion: 0,
      decision: 'RETURN',
      reason: 'TEST correction',
      method: '',
      limitations: '',
      evidenceBasis: null,
      coverage: null,
    });
    const original = structuredClone(f.services.review.write.mock.calls[0]![0]);
    f.owner.claim(actor, { ...target, foremanRevisionId: id(20) });
    f.services.review.read.mockResolvedValue({
      ...read,
      target: { ...target, foremanRevisionId: id(20) },
    });
    const rows = f.owner.recoveries(actor);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('review');
    expect(rows[0]!.target).toEqual(target);
    await rows[0]!.retry();
    expect(f.services.review.write.mock.calls.map(([c]) => c)).toEqual([
      original,
      original,
    ]);
    expect(f.entry.lock).toBeNull();
    expect(f.owner.recoveries(actor)).toEqual([]);
  });
  it('does not apply a late review read after its actor leaves the workspace', async () => {
    const f = setup(true);
    await f.store.read(f.entry, false);
    const read: ManagerReviewReadDto = {
      actorScopeKey: `${id(1)}:${actor}`,
      target,
      revisionNumber: 1,
      reviewVersion: 0,
      declaredQty: '10',
      labels: { crew: 'TEST crew', item: 'TEST work', scope: null },
      unit: coverage.unit,
      scopeRef: coverage.scopeRef,
      capability: { basisRef: id(9), actions: ['RETURN'] },
      evidence: null,
      state: {
        target,
        status: 'NOT_CHECKED',
        coverage: 'NONE',
        confirmedQty: null,
        unit: null,
        eventId: null,
        reviewVersion: 0,
      },
      judgment: null,
    };
    f.services.review.read.mockResolvedValue(read);
    await f.claim.loadReview();
    const review = f.claim.review!;
    let finish!: (value: ManagerReviewReadDto) => void;
    f.services.review.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const loading = review.load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const other = `${id(30)}:${id(31)}`;
    f.owner.bind(other, f.services);
    finish({
      ...read,
      labels: { ...read.labels, crew: 'TEST stale response' },
    });
    await loading;
    expect(review.session.data?.labels.crew).toBe('TEST crew');
    expect(review.session.readError).toBe('FORBIDDEN');
    expect(f.owner.recoveries(other)).toEqual([]);
    expect(review.canStart).toBe(false);
    f.owner.bind(actor, f.services);
    await review.load();
    expect(review.session.readError).toBeNull();
    expect(review.canStart).toBe(true);
  });
  it('another actor cannot see an unresolved old actor recovery row', async () => {
    const f = setup();
    await f.store.read(f.entry, false);
    await f.claim.evidence.load();
    f.write.mockRejectedValueOnce(new ApiError('NETWORK', 503));
    await f.bind();
    const other = `${id(30)}:${id(31)}`;
    f.owner.bind(other, f.services);
    expect(f.owner.recoveries(actor)).toEqual([]);
    expect(f.owner.recoveries(other)).toEqual([]);
    expect(f.entry.lock).not.toBeNull();
  });
  it('keeps an unknown draft save key through inactive transport and same-actor renewal', async () => {
    const f = setup(true);
    await f.store.read(f.entry, false);
    expect(f.store.edit(f.entry, 'weather', 'TEST draft replay')).toBe(true);
    f.api.saveFacts.mockRejectedValueOnce(new ApiError('NETWORK', 503));
    expect(await f.store.flush(f.entry)).toBe('failed');
    const original = structuredClone(f.api.saveFacts.mock.calls[0]![0]);
    f.owner.clearActor();
    expect(await f.store.flush(f.entry)).toBe('failed');
    expect(f.api.saveFacts).toHaveBeenCalledTimes(1);
    f.owner.bind(actor, f.services);
    const fresh = {
      ...f.api,
      day: vi.fn(async () => {
        const current = day(2);
        current.facts.weather = 'TEST draft replay';
        return current;
      }),
      saveFacts: vi.fn(async (command: SaveFactsCommand) => ({
        businessDate: command.businessDate,
        version: 2,
        state: 'draft' as const,
      })),
    };
    expect(f.owner.dayStoreFor(actor, target.projectId, fresh)).toBe(f.store);
    expect(await f.store.flush(f.entry)).toBe('ok');
    expect(fresh.saveFacts.mock.calls.map(([command]) => command)).toEqual([
      original,
    ]);
    expect(f.entry.session.facts.weather).toBe('TEST draft replay');
  });
  it('acknowledges a sent draft save only in its original store after another actor binds', async () => {
    const f = setup(true);
    await f.store.read(f.entry, false);
    f.store.edit(f.entry, 'weather', 'TEST original acknowledged');
    let finish!: () => void;
    f.api.saveFacts.mockImplementationOnce(async (command) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { businessDate: command.businessDate, version: 2, state: 'draft' };
    });
    const saving = f.store.flush(f.entry);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const other = `${id(30)}:${id(31)}`;
    f.owner.bind(other, f.services);
    const otherStore = f.owner.dayStoreFor(other, target.projectId, f.api);
    finish();
    expect(await saving).toBe('ok');
    expect(f.entry.session.state).toBe('saved');
    expect(f.entry.session.version).toBe(2);
    expect(f.entry.session.facts.weather).toBe('TEST original acknowledged');
    expect(
      otherStore.entry(target.projectId, target.businessDate).session.facts
        .weather,
    ).not.toBe('TEST original acknowledged');
    expect(f.api.saveFacts).toHaveBeenCalledTimes(1);
  });
  it('retains the canonical store and original unknown command across verified same-actor remount', async () => {
    const f = setup(true);
    await f.store.read(f.entry, false);
    await f.claim.evidence.load();
    f.write.mockRejectedValueOnce(new ApiError('NETWORK', 503));
    await f.bind();
    const original = structuredClone(f.write.mock.calls[0]![0]);
    const oldReads = f.api.day.mock.calls.length;
    f.owner.clearActor();
    const freshWrite = vi.fn(async (command: BusinessEvidenceCommand) => ({
      target: command.target,
    }));
    f.owner.bind(actor, {
      ...f.services,
      evidence: { ...f.services.evidence, command: freshWrite },
    });
    const freshApi = { ...f.api, day: vi.fn(async () => day()) };
    const remounted = f.owner.dayStoreFor(actor, target.projectId, freshApi);
    expect(remounted).toBe(f.store);
    expect(remounted.entry(target.projectId, target.businessDate)).toBe(
      f.entry,
    );
    expect(remounted.acquire(f.entry, 'TEST_competing_submit')).toBe(false);
    expect(() =>
      f.owner.dayStore(target.projectId, new DayStore(freshApi, () => {})),
    ).toThrow();
    await f.owner.recoveries(actor)[0]!.retry();
    expect(freshWrite.mock.calls.map(([c]) => c)).toEqual([original]);
    expect(f.api.day).toHaveBeenCalledTimes(oldReads);
    expect(freshApi.day).toHaveBeenCalled();
    expect(f.entry.lock).toBeNull();
  });
  it('isolates another actor store and keeps the old unknown request available on return', async () => {
    const f = setup(true);
    await f.store.read(f.entry, false);
    await f.claim.evidence.load();
    f.write.mockRejectedValueOnce(new ApiError('NETWORK', 503));
    await f.bind();
    const original = f.claim.evidence.actions.current;
    const key = f.entry.lock;
    const other = `${id(30)}:${id(31)}`;
    f.owner.bind(other, f.services);
    const otherStore = f.owner.dayStoreFor(other, target.projectId, f.api);
    expect(otherStore).not.toBe(f.store);
    expect(
      otherStore.entry(target.projectId, target.businessDate).lock,
    ).toBeNull();
    expect(() => f.owner.claim(actor, target)).toThrow();
    expect(f.owner.recoveries(other)).toEqual([]);
    expect(await f.claim.evidence.retry()).toMatchObject({
      code: 'ACTOR_CHANGED',
    });
    f.claim.evidence.discard();
    expect(f.claim.evidence.actions.current).toBe(original);
    expect(f.entry.lock).toBe(key);
    const calls = f.api.day.mock.calls.length;
    expect(await f.store.read(f.entry, false)).toBe('failed');
    expect(f.api.day).toHaveBeenCalledTimes(calls);
    f.owner.bind(actor, f.services);
    expect(f.owner.dayStoreFor(actor, target.projectId, f.api)).toBe(f.store);
    await f.owner.recoveries(actor)[0]!.retry();
    expect(f.write).toHaveBeenCalledTimes(2);
    expect(f.entry.lock).toBeNull();
  });
  it('keeps an original retry unsettled when the actor changes during preparation', async () => {
    const f = setup(true);
    await f.store.read(f.entry, false);
    await f.claim.evidence.load();
    f.write.mockRejectedValueOnce(new ApiError('NETWORK', 503));
    await f.bind();
    const original = f.claim.evidence.actions.current;
    let finish!: () => void;
    vi.spyOn(f.store, 'hold').mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { outcome: 'ok', version: 1 };
    });
    const retry = f.claim.evidence.retry();
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.owner.bind(`${id(30)}:${id(31)}`, f.services);
    finish();
    expect(await retry).toMatchObject({ kind: 'failed', code: 'RETRY' });
    expect(f.claim.evidence.actions.current).toBe(original);
    expect(f.claim.evidence.actions.unresolved).not.toBeNull();
    expect(f.write).toHaveBeenCalledTimes(1);
    f.owner.bind(actor, f.services);
    await f.claim.evidence.retry();
    expect(f.write.mock.calls[1]![0]).toEqual(f.write.mock.calls[0]![0]);
  });
  it('notifies the workspace when an external day reload clears a stale evidence row', async () => {
    const f = setup();
    await f.store.read(f.entry, false);
    await f.claim.evidence.load();
    f.api.day.mockRejectedValueOnce(new ApiError('NETWORK', 503));
    await f.bind();
    expect(f.owner.recoveries(actor)).toHaveLength(1);
    const changed = vi.fn();
    const unsubscribe = f.owner.subscribe(changed);
    await f.store.reloadLocked(f.entry);
    expect(changed).toHaveBeenCalled();
    expect(f.owner.recoveries(actor)).toEqual([]);
    expect(f.claim.evidence.canEdit).toBe(true);
    unsubscribe();
  });
  it('uses the same workspace owner across tab and date changes', () => {
    const f = setup();
    expect(f.owner.claim(actor, target)).toBe(f.claim);
    expect(
      f.owner.claim(actor, { ...target, foremanRevisionId: id(20) }),
    ).not.toBe(f.claim);
  });
  it('competing day actions cannot be unlocked by another review owner', async () => {
    const f = setup();
    const lock = managerReviewDayLock(
      f.store,
      target.projectId,
      target.businessDate,
    );
    expect(f.store.acquire(f.entry, 'TEST_submit')).toBe(true);
    expect(lock.acquire('TEST_review')).toBe(false);
    lock.abandon('TEST_review');
    expect(await lock.release('TEST_review', 'saved')).toBe(false);
    expect(f.entry.lock).toBe('TEST_submit');
  });
  it('unknown photo association holds the day and retries exactly the original command/key', async () => {
    const f = setup();
    await f.store.read(f.entry, false);
    await f.claim.evidence.load();
    f.write.mockRejectedValueOnce(new ApiError('NETWORK', 503));
    await f.bind();
    const original = structuredClone(f.write.mock.calls[0]![0]);
    expect(f.entry.lock).toBe(original.clientMutationId);
    expect(f.store.acquire(f.entry, 'TEST_submit')).toBe(false);
    expect(f.claim.evidence.canEdit).toBe(false);
    expect(f.owner.claim(actor, target)).toBe(f.claim);
    await f.claim.evidence.retry();
    expect(f.write.mock.calls.map(([c]) => c)).toEqual([original, original]);
    expect(f.entry.lock).toBeNull();
    expect(f.entry.session.facts).toMatchObject({
      weather: 'TEST_weather',
      siteLocation: 'TEST_address',
      temperature: '26',
      people: { TEST_crew: '8' },
    });
  });
  it('retains ownership when the parent read after success fails', async () => {
    const f = setup();
    await f.store.read(f.entry, false);
    await f.claim.evidence.load();
    f.api.day.mockRejectedValueOnce(new ApiError('NETWORK', 503));
    await f.bind();
    expect(f.entry.lock).not.toBeNull();
    expect(f.claim.evidence.canEdit).toBe(false);
    expect(f.entry.stale).toBe(true);
    await f.store.reloadLocked(f.entry);
    expect(f.entry.lock).toBeNull();
    expect(f.claim.evidence.canEdit).toBe(true);
  });
  it('does not send an unresolved original command as a different signed-in natural person/account', async () => {
    const f = setup();
    await f.store.read(f.entry, false);
    await f.claim.evidence.load();
    f.write.mockRejectedValueOnce(new ApiError('NETWORK', 503));
    await f.bind();
    f.owner.bind(`${id(30)}:${id(31)}`, f.services);
    await f.claim.evidence.retry();
    expect(f.write).toHaveBeenCalledTimes(1);
  });
  it('does not show a newer declaration review beside an old immutable evidence target', async () => {
    const f = setup();
    f.services.review.read.mockResolvedValueOnce({
      actorScopeKey: `${id(1)}:${actor}`,
      target: { ...target, foremanRevisionId: id(40) },
    } as ManagerReviewReadDto);
    await f.claim.loadReview();
    expect(f.claim.review).toBeNull();
    expect(f.claim.reviewError).toBe('TARGET_CHANGED');
  });
  it('missing formal policy remains unavailable, never inferred from ordinary report-write access', async () => {
    const f = setup();
    await f.claim.loadReview();
    expect(f.claim.review).toBeNull();
    expect(f.claim.reviewError).toBe('FORBIDDEN');
  });
});
