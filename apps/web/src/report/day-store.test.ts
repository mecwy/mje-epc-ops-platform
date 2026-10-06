import { describe, expect, it, vi } from 'vitest';
import type { ReportLocationOperation, SaveFactsCommand } from '@mje/contracts';
import { ApiError, type DayView } from '../api.js';
import { DayStore, emptyFacts } from './day-store.js';
const capture: ReportLocationOperation = {
  kind: 'capture',
  candidate: {
    lat: '1.123456789012',
    lon: '-1.123456789012',
    accuracyM: '40.12',
    deviceFixAt: null,
    acquiredAt: '2026-10-06T12:00:00Z',
  },
  clientConfirmedAt: '2026-10-06T12:01:00Z',
};
function day(version = 1, state: DayView['state'] = 'draft'): DayView {
  return {
    projectId: 'TEST-project',
    businessDate: '2026-10-06',
    siteTimezone: 'UTC',
    facts: emptyFacts(),
    state,
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
function setup() {
  const api = {
    day: vi.fn(async () => day()),
    revision: vi.fn(),
    saveFacts: vi.fn(async (command: SaveFactsCommand) => ({
      businessDate: command.businessDate,
      version: 2,
      state: 'draft' as const,
    })),
  };
  const store = new DayStore(api, vi.fn());
  const entry = store.entry('TEST-project', '2026-10-06');
  return { api, store, entry };
}
describe('C03 composes with the existing day lock', () => {
  it('sends capture outside facts and keeps the lock until its post-write read applies', async () => {
    const { api, store, entry } = setup();
    await store.read(entry, false);
    let resolve!: (value: DayView) => void;
    api.day.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    expect(
      store.editWeather(
        entry,
        { ...entry.session.facts, weather: 'TEST manual' },
        capture,
      ),
    ).toBe(true);
    const pending = store.flush(entry);
    await vi.waitFor(() => expect(api.day).toHaveBeenCalledTimes(2));
    expect(api.saveFacts).toHaveBeenCalledTimes(1);
    expect(api.saveFacts.mock.calls[0]![0].reportLocationOperation).toEqual(
      capture,
    );
    expect(JSON.stringify(api.saveFacts.mock.calls[0]![0].facts)).not.toContain(
      capture.candidate.lat,
    );
    expect(entry.lock).not.toBeNull();
    expect(store.edit(entry, 'weather', 'TEST replacement')).toBe(false);
    const fresh = day(2);
    fresh.facts.weather = 'TEST manual';
    resolve(fresh);
    expect(await pending).toBe('ok');
    expect(entry.lock).toBeNull();
    expect(entry.session.pendingLocationKind).toBeNull();
    expect(entry.session.weatherNeedsSave).toBe(false);
  });
  it('retains capture payload/key after a lost response and a later permission refusal', async () => {
    const { api, store, entry } = setup();
    await store.read(entry, false);
    api.saveFacts
      .mockRejectedValueOnce(new ApiError('NETWORK', 0))
      .mockRejectedValueOnce(new ApiError('FORBIDDEN', 403));
    expect(store.editWeather(entry, entry.session.facts, capture)).toBe(true);
    expect(await store.flush(entry)).toBe('failed');
    const first = JSON.stringify(api.saveFacts.mock.calls[0]![0]);
    expect(entry.lock).not.toBeNull();
    expect(await store.flush(entry)).toBe('failed');
    expect(JSON.stringify(api.saveFacts.mock.calls[1]![0])).toBe(first);
    expect(entry.session.weatherUnknown).toBe(true);
    expect(
      store.editWeather(entry, entry.session.facts, { kind: 'clear' }),
    ).toBe(false);
    expect(entry.session.pendingLocationKind).toBe('capture');
    expect(api.day).toHaveBeenCalledTimes(1);
  });
  it.each(['VERSION_CONFLICT', 'LOCKED'])(
    'settles %s after a lost response and retains manual inputs',
    async (code) => {
      const { api, store, entry } = setup();
      await store.read(entry, false);
      api.saveFacts
        .mockRejectedValueOnce(new ApiError('NETWORK', 0))
        .mockRejectedValueOnce(new ApiError(code, 409));
      const fresh = day(3);
      fresh.facts.weather = 'TEST another writer';
      api.day.mockResolvedValueOnce(fresh);
      expect(
        store.editWeather(
          entry,
          { ...entry.session.facts, weather: 'TEST my manual input' },
          capture,
        ),
      ).toBe(true);
      expect(await store.flush(entry)).toBe('failed');
      const first = JSON.stringify(api.saveFacts.mock.calls[0]![0]);
      expect(await store.flush(entry)).toBe('conflict');
      expect(JSON.stringify(api.saveFacts.mock.calls[1]![0])).toBe(first);
      expect(entry.lock).toBeNull();
      expect(entry.session.weatherUnknown).toBe(false);
      expect(entry.session.pendingLocationKind).toBeNull();
      expect(entry.session.facts.weather).toBe('TEST another writer');
      expect(entry.session.retained).toContainEqual({
        path: 'weather',
        mine: 'TEST my manual input',
      });
      expect(store.edit(entry, 'temperature', '20')).toBe(true);
      store.cancelAutosave();
    },
  );
  it('retains manual inputs until refresh after the decisive conflict read fails', async () => {
    const { api, store, entry } = setup();
    await store.read(entry, false);
    api.saveFacts
      .mockRejectedValueOnce(new ApiError('NETWORK', 0))
      .mockRejectedValueOnce(new ApiError('VERSION_CONFLICT', 409));
    api.day.mockRejectedValueOnce(new ApiError('NETWORK', 0));
    store.editWeather(
      entry,
      { ...entry.session.facts, weather: 'TEST retained input' },
      capture,
    );
    expect(await store.flush(entry)).toBe('failed');
    expect(await store.flush(entry)).toBe('conflict');
    expect(entry.stale).toBe(true);
    expect(entry.lock).not.toBeNull();
    const fresh = day(3);
    fresh.facts.weather = 'TEST current';
    api.day.mockResolvedValueOnce(fresh);
    expect(await store.reloadLocked(entry)).toBe(true);
    expect(entry.lock).toBeNull();
    expect(api.saveFacts).toHaveBeenCalledTimes(2);
    expect(entry.session.retained).toContainEqual({
      path: 'weather',
      mine: 'TEST retained input',
    });
  });
  it('failed fresh read retains the saved operation and refresh unlocks without a resend', async () => {
    const { api, store, entry } = setup();
    await store.read(entry, false);
    api.day.mockRejectedValueOnce(new ApiError('NETWORK', 0));
    store.editWeather(entry, entry.session.facts, { kind: 'clear' });
    expect(await store.flush(entry)).toBe('ok');
    expect(entry.stale).toBe(true);
    expect(entry.lock).not.toBeNull();
    expect(entry.session.pendingLocationKind).toBe('clear');
    api.day.mockResolvedValueOnce(day(2));
    expect(await store.reloadLocked(entry)).toBe(true);
    expect(api.saveFacts).toHaveBeenCalledTimes(1);
    expect(entry.lock).toBeNull();
    expect(entry.session.pendingLocationKind).toBeNull();
  });
  it('another day command, submitted day and reader access refuse weather intent', async () => {
    const { store, entry } = setup();
    await store.read(entry, false);
    store.acquire(entry, 'TEST-other');
    expect(store.editWeather(entry, entry.session.facts, capture)).toBe(false);
    store.abandon(entry, 'TEST-other');
    entry.day!.state = 'submitted';
    expect(store.editWeather(entry, entry.session.facts, capture)).toBe(false);
    entry.day!.state = 'draft';
    entry.day!.access = 'read';
    expect(store.editWeather(entry, entry.session.facts, capture)).toBe(false);
  });
});
