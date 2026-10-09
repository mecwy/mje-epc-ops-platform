import { it, expect, vi } from 'vitest';
import type {
  MaterialContinuityView,
  AdmitMaterialUseCommand,
} from '@mje/contracts';
import { ApiError, type DayView, type IssueList } from '../api.js';
import { DayStore, emptyFacts } from './day-store.js';
import { materialContinuitySession } from './material-continuity-session.js';
const projectId = '10000000-0000-4000-8000-000000000001',
  businessDate = '2031-01-01';
const view: MaterialContinuityView = {
  projectId,
  businessDate,
  access: 'write',
  scopes: [],
  frozen: null,
};
const payload = {
  projectId,
  businessDate,
  scopeId: projectId,
  expectedVersion: 1,
  records: [
    {
      sourceBusinessDate: businessDate,
      revisionNumber: 1,
      useFactId: projectId,
      issueId: null,
      dueAt: null,
    },
  ],
};
function rig() {
  let readFails = false;
  const day = {
    projectId,
    businessDate,
    siteTimezone: 'UTC',
    facts: emptyFacts(),
    state: 'draft',
    version: 1,
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
  const dayApi = {
    day: vi.fn(async () => {
      if (readFails) throw new ApiError('NETWORK', 0);
      return day;
    }),
    revision: vi.fn(),
    saveFacts: vi.fn(),
  };
  const store = new DayStore(dayApi, vi.fn());
  const api = {
    issues: vi.fn(async (): Promise<IssueList> => ({
      access: 'write' as const,
      projectId,
      businessDate,
      issues: [],
    })),
    readMaterialContinuity: vi.fn(async () => view),
    admitMaterialUse: vi.fn(async (command: AdmitMaterialUseCommand) => ({
      scopeId: command.scopeId,
      version: 2,
      key: command.clientMutationId,
    })),
    initializeMaterialScope: vi.fn(),
  };
  const session = materialContinuitySession(
    api,
    store,
    projectId,
    businessDate,
  );
  return {
    api,
    store,
    session,
    entry: store.entry(projectId, businessDate),
    failDayRead: (value: boolean) => (readFails = value),
  };
}
it('retains exactly the edited revision, version and key across an unanswered admission retry', async () => {
  const r = rig();
  await r.session.load();
  r.api.admitMaterialUse.mockRejectedValueOnce(new ApiError('NETWORK', 0));
  const action = { kind: 'admit' as const, payload: structuredClone(payload) };
  expect(await r.session.run(action)).toBe(false);
  expect(r.entry.lock).not.toBeNull();
  const first = structuredClone(r.api.admitMaterialUse.mock.calls[0]![0]);
  action.payload.expectedVersion = 99;
  action.payload.records[0]!.revisionNumber = 99;
  expect(await r.session.run({ kind: 'admit', payload })).toBe(false);
  await r.session.retry();
  expect(r.api.admitMaterialUse.mock.calls[1]![0]).toEqual(first);
  expect(first.expectedVersion).toBe(1);
  expect(first.records[0]!.revisionNumber).toBe(1);
  expect(r.entry.lock).toBeNull();
  expect(r.session.commands.owned).toBe(false);
});
it('keeps the day locked after a successful write until the day refresh succeeds', async () => {
  const r = rig();
  await r.session.load();
  r.failDayRead(true);
  expect(await r.session.run({ kind: 'admit', payload })).toBe(true);
  expect(r.entry.lock).not.toBeNull();
  expect(r.entry.stale).toBe(true);
  expect(await r.session.run({ kind: 'admit', payload })).toBe(false);
  r.failDayRead(false);
  await r.session.load();
  expect(r.entry.lock).toBeNull();
});
it('reuses workspace ownership through remount and rejects another date or project before sending', async () => {
  const r = rig();
  await r.session.load();
  expect(
    materialContinuitySession(r.api, r.store, projectId, businessDate),
  ).toBe(r.session);
  expect(
    await r.session.run({
      kind: 'admit',
      payload: { ...payload, businessDate: '2031-01-02' },
    }),
  ).toBe(false);
  expect(
    await r.session.run({
      kind: 'admit',
      payload: {
        ...payload,
        projectId: '20000000-0000-4000-8000-000000000002',
      },
    }),
  ).toBe(false);
  expect(r.api.admitMaterialUse).not.toHaveBeenCalled();
  expect(r.entry.lock).toBeNull();
});
it('does not claim a command when the existing report editor owns the day', async () => {
  const r = rig();
  await r.session.load();
  expect(r.store.acquire(r.entry, 'TEST_report_editor')).toBe(true);
  expect(await r.session.run({ kind: 'admit', payload })).toBe(false);
  expect(r.api.admitMaterialUse).not.toHaveBeenCalled();
  expect(r.entry.lock).toBe('TEST_report_editor');
});

it('retains all unsaved opening inputs after a definite rejection and remount, isolated by business day', async () => {
  const { session, api, store } = rig();
  await session.load();
  const draft = {
    quantity: '500',
    basis: 'TEST independent opening basis',
    ownership: 'TEST owner',
    custody: 'TEST custodian',
    location: 'TEST roof',
    date: businessDate,
    cutoff: '2031-01-01T12:00:00Z',
  };
  Object.assign(session.openingDraft, draft);
  session.openingExpanded = true;
  api.initializeMaterialScope.mockRejectedValueOnce(
    new ApiError('INVALID_INPUT', 400),
  );
  await session.run({
    kind: 'initialize',
    payload: {
      projectId,
      materialItemId: projectId,
      materialKey: 'mounts',
      specification: 'TEST specification',
      unit: 'set',
      workPackageId: 'TEST work package',
      scopeVersion: '1',
      ownership: draft.ownership,
      custody: draft.custody,
      location: draft.location,
      openingDate: draft.date,
      openingCutoffAt: draft.cutoff,
      openingQuantity: draft.quantity,
      openingBasis: draft.basis,
    },
  });
  const remounted = materialContinuitySession(
    api,
    store,
    projectId,
    businessDate,
  );
  expect(remounted.openingDraft).toEqual(draft);
  expect(remounted.openingExpanded).toBe(true);
  expect(remounted.session.error).toBe('INVALID_INPUT');
  expect(
    materialContinuitySession(api, store, projectId, '2031-01-02').openingDraft
      .quantity,
  ).toBe('');
});

it('loads current followups through the existing issue API while keeping the report issue snapshot unchanged', async () => {
  const r = rig(),
    snapshot = structuredClone(view);
  const issue = {
    id: projectId,
    closedOn: null,
    dueOn: businessDate,
    ownerPersonId: projectId,
    title: 'TEST created after report submission',
  };
  r.api.issues.mockResolvedValueOnce({
    access: 'write',
    projectId,
    businessDate,
    issues: [issue, { ...issue, id: 'closed', closedOn: businessDate }],
  } as IssueList);
  expect(await r.session.readFollowups()).toEqual([issue]);
  expect(r.api.issues).toHaveBeenCalledWith(projectId, businessDate);
  expect(view).toEqual(snapshot);
});
