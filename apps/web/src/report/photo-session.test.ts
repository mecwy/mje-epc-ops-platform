import { describe, expect, it } from 'vitest';
import type { CaptureFixDto, PhotoDto, PhotoLinkDto } from '@mje/contracts';
import {
  ApiError,
  type PhotoList,
  type PhotoUpload,
  type PhotoUploadResult,
} from '../api.js';
import type { LocateResult } from './geo.js';
import { PhotoSession, type PickedFile } from './photo-session.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};
const photo = (
  id: string,
  linkVersion: number,
  link: PhotoLinkDto | null = null,
  businessDate = 'A',
): PhotoDto => ({
  id,
  projectId: 'p',
  businessDate,
  source: 'album',
  mediaType: 'image/jpeg',
  sizeBytes: 10,
  sha256: `sha-${id}`,
  capture: null,
  deviceCapturedAt: null,
  file: { takenLocal: null, takenAt: null, gps: null },
  location: 'none',
  hasThumbnail: true,
  receivedAt: '2026-10-01T08:00:00.000Z',
  uploadedByPersonId: 'TEST-person',
  link,
  linkVersion,
});
/** A synthetic picture file (TEST bytes, not an image anyone took). */
const file = (size = 8, type = 'image/jpeg'): PickedFile =>
  new Blob([new Uint8Array(size).fill(7)], { type }) as PickedFile;
const FIX: CaptureFixDto = {
  lat: '44.000001',
  lon: '20.000002',
  accuracyM: '12.00',
  fixAt: '2026-10-01T07:59:58.000Z',
};

/** A fake API whose reads and writes the test settles one by one. */
function fake(initial: PhotoDto[] = []) {
  let list = initial;
  const reads: {
    date: string;
    settle: (e?: Error) => void;
  }[] = [];
  const uploads: {
    upload: PhotoUpload;
    progress: (p: number) => void;
    settle: (r: PhotoUploadResult | Error) => void;
  }[] = [];
  const writes: {
    kind: 'link' | 'unlink';
    command: Record<string, unknown>;
    settle: (e?: Error) => void;
  }[] = [];
  let autoRead = true;
  const api = {
    photos: (_p: string, date: string): Promise<PhotoList> => {
      const snapshot = list.filter((x) => x.businessDate === date);
      const result = (): PhotoList => ({
        access: 'write',
        projectId: 'p',
        businessDate: date,
        photos: snapshot,
        unlinkedPhotos: snapshot.filter((x) => !x.link).length,
      });
      if (autoRead) return Promise.resolve(result());
      return new Promise((resolve, reject) =>
        reads.push({
          date,
          settle: (e) => (e ? reject(e) : resolve(result())),
        }),
      );
    },
    uploadPhoto: (upload: PhotoUpload, progress: (p: number) => void) =>
      new Promise<PhotoUploadResult>((resolve, reject) =>
        uploads.push({
          upload,
          progress,
          settle: (r) => (r instanceof Error ? reject(r) : resolve(r)),
        }),
      ),
    // A write answers with the photo as stored when the test settles it.
    linkPhoto: (command: Record<string, unknown>) =>
      new Promise<PhotoDto>((resolve, reject) =>
        writes.push({
          kind: 'link',
          command,
          settle: (e) =>
            e
              ? reject(e)
              : resolve(list.find((x) => x.id === command['photoId'])!),
        }),
      ),
    unlinkPhoto: (command: Record<string, unknown>) =>
      new Promise<PhotoDto>((resolve, reject) =>
        writes.push({
          kind: 'unlink',
          command,
          settle: (e) =>
            e
              ? reject(e)
              : resolve(list.find((x) => x.id === command['photoId'])!),
        }),
      ),
  };
  return {
    api,
    reads,
    uploads,
    writes,
    set: (next: PhotoDto[]) => (list = next),
    manualReads: (on: boolean) => (autoRead = !on),
  };
}
let n = 0;
function session(
  api: unknown,
  date = 'A',
  locate: () => Promise<LocateResult> = async () => ({
    fix: FIX,
    reason: null,
  }),
) {
  return new PhotoSession(api as never, 'p', date, () => undefined, {
    newId: () => `k${++n}`,
    locate,
    thumbnail: async (f) => new Blob([`thumb-${f.size}`]),
    now: () => '2026-10-01T08:00:00.000Z',
  });
}
const stored = (u: PhotoUpload, id: string): PhotoUploadResult => ({
  ...photo(id, u.link ? 1 : 0, u.link, u.businessDate),
  deduplicated: false,
});

describe('photo session', () => {
  it('knows nothing until a read lands: unlinked is unknown, not 0', async () => {
    const f = fake([photo('x', 0)]);
    f.manualReads(true);
    const s = session(f.api);
    const loading = s.load();
    expect(s.unlinked).toBeNull();
    expect(s.photographed()).toBeNull();
    f.reads[0]!.settle();
    await loading;
    expect(s.unlinked).toBe(1);
    expect(s.photographed()).toEqual(new Set());
  });

  it('an upload in flight for one day lands on that day only', async () => {
    const f = fake();
    const a = session(f.api, 'A');
    const b = session(f.api, 'B');
    await a.load();
    await b.load();
    await a.addAlbum([file()], { type: 'item', id: 'support' });
    await settle();
    // The screen moved to day B; the upload for A is still in flight.
    expect(f.uploads).toHaveLength(1);
    expect(f.uploads[0]!.upload.businessDate).toBe('A');
    f.set([photo('pa', 1, { type: 'item', id: 'support' }, 'A')]);
    f.uploads[0]!.settle(stored(f.uploads[0]!.upload, 'pa'));
    await settle();
    expect(a.photos?.map((p) => p.id)).toEqual(['pa']);
    expect(b.photos).toEqual([]);
    expect(b.jobs).toEqual([]);
  });

  it('an in-app photo carries its fix and device time; an album photo never the uploader position', async () => {
    const f = fake();
    const s = session(f.api);
    await s.load();
    const capture = s.beginCapture({ type: 'issue', id: 'i1' });
    await s.addCamera(capture, file());
    await s.addAlbum([file(9)], null);
    await settle();
    const camera = f.uploads[0]!.upload;
    expect(camera).toMatchObject({
      source: 'camera',
      fix: FIX,
      takenAt: '2026-10-01T08:00:00.000Z',
      link: { type: 'issue', id: 'i1' },
      clientMutationId: camera.clientMutationId,
    });
    expect(camera.thumbnail).not.toBeNull();
    f.uploads[0]!.settle(stored(camera, 'c1'));
    await settle();
    const album = f.uploads[1]!.upload;
    expect(album).toMatchObject({
      source: 'album',
      fix: null,
      takenAt: null,
      link: null,
    });
  });

  it('an in-app photo without a fix is not sent; it is kept with the reason until a fix is had', async () => {
    const f = fake();
    let answer: LocateResult = { fix: null, reason: 'denied' };
    let asked = 0;
    const s = session(f.api, 'A', async () => {
      asked++;
      return answer;
    });
    await s.load();
    await s.addCamera(s.beginCapture({ type: 'item', id: 'support' }), file());
    await settle();
    expect(f.uploads).toHaveLength(0);
    expect(s.jobs).toMatchObject([{ state: 'noLocation', error: 'denied' }]);
    const key = s.jobs[0]!.key;
    // Still none: still not sent.
    answer = { fix: null, reason: 'noFix' };
    await s.relocate(key);
    await settle();
    expect(f.uploads).toHaveLength(0);
    expect(s.jobs[0]).toMatchObject({ state: 'noLocation', error: 'noFix' });
    answer = { fix: FIX, reason: null };
    await s.relocate(key);
    await settle();
    expect(asked).toBe(3);
    expect(f.uploads).toHaveLength(1);
    expect(f.uploads[0]!.upload).toMatchObject({
      clientMutationId: key,
      fix: FIX,
    });
  });

  it('a lost upload is unknown, not failed: retry resends the same key, bytes, thumbnail and fix', async () => {
    const f = fake();
    const s = session(f.api);
    await s.load();
    await s.addCamera(s.beginCapture({ type: 'item', id: 'support' }), file());
    await settle();
    const first = f.uploads[0]!.upload;
    f.uploads[0]!.progress(40);
    expect(s.jobs[0]).toMatchObject({ state: 'sending', progress: 40 });
    f.uploads[0]!.settle(new ApiError('NETWORK', 0));
    await settle();
    expect(s.jobs[0]).toMatchObject({ state: 'failed', error: 'NETWORK' });
    expect(s.jobs[0]!.file).toBe(first.photo);
    s.retryUpload(s.jobs[0]!.key);
    await settle();
    const again = f.uploads[1]!.upload;
    expect(again.clientMutationId).toBe(first.clientMutationId);
    expect(again.photo).toBe(first.photo);
    expect(again.thumbnail).toBe(first.thumbnail);
    expect(again.fix).toEqual(first.fix);
    expect(again.takenAt).toBe(first.takenAt);
    expect(again.link).toEqual(first.link);
    // A 5xx is no more definite than a lost connection.
    f.uploads[1]!.settle(new ApiError('REQUEST_FAILED', 502));
    await settle();
    expect(s.jobs[0]!.state).toBe('failed');
    s.retryUpload(s.jobs[0]!.key);
    await settle();
    f.set([photo('c', 1, { type: 'item', id: 'support' })]);
    f.uploads[2]!.settle({ ...stored(f.uploads[2]!.upload, 'c') });
    await settle();
    expect(s.jobs).toEqual([]);
    expect(s.photos?.map((p) => p.id)).toEqual(['c']);
  });

  it('a definite refusal releases the bytes and cannot be resent', async () => {
    const f = fake();
    const s = session(f.api);
    await s.load();
    await s.addAlbum([file()], null);
    await settle();
    f.uploads[0]!.settle(new ApiError('PHOTO_ELSEWHERE', 409));
    await settle();
    expect(s.jobs[0]).toMatchObject({
      state: 'rejected',
      error: 'PHOTO_ELSEWHERE',
      file: null,
      thumb: null,
    });
    s.retryUpload(s.jobs[0]!.key);
    await settle();
    expect(f.uploads).toHaveLength(1);
    s.discard(s.jobs[0]!.key);
    expect(s.jobs).toEqual([]);
  });

  it('refuses over 10 MB or a non-photo type on the device, without sending', async () => {
    const f = fake();
    const s = session(f.api);
    await s.load();
    await s.addAlbum(
      [file(10 * 1024 * 1024 + 1), file(8, 'image/gif'), file(0)],
      null,
    );
    await s.addCamera(s.beginCapture(null), file(8, 'image/svg+xml'));
    await settle();
    expect(f.uploads).toHaveLength(0);
    expect(s.jobs.map((j) => [j.state, j.error])).toEqual([
      ['rejected', 'PHOTO_TOO_LARGE'],
      ['rejected', 'UNSUPPORTED_MEDIA'],
      ['rejected', 'UNSUPPORTED_MEDIA'],
      ['rejected', 'UNSUPPORTED_MEDIA'],
    ]);
    // Exactly 10 MB is allowed.
    await s.addAlbum([file(10 * 1024 * 1024)], null);
    await settle();
    expect(f.uploads).toHaveLength(1);
  });

  it('sends uploads one at a time', async () => {
    const f = fake();
    const s = session(f.api);
    await s.load();
    await s.addAlbum([file(1), file(2)], null);
    await settle();
    expect(f.uploads).toHaveLength(1);
    expect(s.jobs.map((j) => j.state)).toEqual(['sending', 'queued']);
    f.uploads[0]!.settle(stored(f.uploads[0]!.upload, 'a'));
    await settle();
    expect(f.uploads).toHaveLength(2);
  });

  it('a read that started before a link change never replaces its result', async () => {
    const f = fake([photo('x', 0)]);
    const s = session(f.api);
    await s.load();
    f.manualReads(true);
    // A read is in flight (it will answer: unlinked, version 0) when the link is saved.
    const old = s.load();
    const linking = s.link('x', { type: 'item', id: 'support' });
    await settle();
    expect(f.writes[0]!.command).toMatchObject({
      photoId: 'x',
      expectedVersion: 0,
      link: { type: 'item', id: 'support' },
    });
    f.set([photo('x', 1, { type: 'item', id: 'support' })]);
    f.writes[0]!.settle();
    await settle();
    expect(s.find('x')).toMatchObject({ linkVersion: 1 });
    // The stale answer arrives after the write: it must not undo the link on screen.
    f.reads[0]!.settle();
    await old;
    expect(s.find('x')).toMatchObject({
      linkVersion: 1,
      link: { type: 'item', id: 'support' },
    });
    // The read started after the write is applied.
    f.reads[1]!.settle();
    expect(await linking).toBe('ok');
    expect(s.unlinked).toBe(0);
    // The next command is built from the new version.
    f.manualReads(false);
    const unlinking = s.link('x', null);
    await settle();
    expect(f.writes[1]).toMatchObject({
      kind: 'unlink',
      command: { photoId: 'x', expectedVersion: 1 },
    });
    f.writes[1]!.settle();
    await unlinking;
  });

  it('a read that started before an upload finished never removes the stored photo', async () => {
    const f = fake();
    const s = session(f.api);
    await s.load();
    await s.addAlbum([file()], null);
    await settle();
    f.manualReads(true);
    const old = s.load(); // answers: no photos
    f.set([photo('u', 0)]);
    f.uploads[0]!.settle(stored(f.uploads[0]!.upload, 'u'));
    await settle();
    expect(s.photos?.map((p) => p.id)).toEqual(['u']);
    f.reads[0]!.settle();
    await old;
    expect(s.photos?.map((p) => p.id)).toEqual(['u']);
    expect(s.jobs).toEqual([]);
  });

  it('builds a queued link command with the version current when it runs', async () => {
    let version = 3;
    const f = fake();
    f.set([photo('x', version)]);
    const s = session(f.api);
    await s.load();
    const first = s.link('x', { type: 'item', id: 'a' });
    const second = s.link('x', { type: 'issue', id: 'i1' });
    await settle();
    expect(f.writes).toHaveLength(1);
    version = 4;
    f.set([photo('x', version, { type: 'item', id: 'a' })]);
    f.writes[0]!.settle();
    await settle();
    expect(f.writes[1]!.command).toMatchObject({
      expectedVersion: 4,
      link: { type: 'issue', id: 'i1' },
    });
    f.writes[1]!.settle();
    expect(await first).toBe('ok');
    expect(await second).toBe('ok');
  });

  it('a lost link command keeps its key; retry resends it unchanged and nothing else is sent meanwhile', async () => {
    const f = fake([photo('x', 2)]);
    const s = session(f.api);
    await s.load();
    const first = s.link('x', { type: 'item', id: 'a' });
    await settle();
    f.writes[0]!.settle(new ApiError('NETWORK', 0));
    expect(await first).toBe('failed');
    expect(s.needsRetry).toBe(true);
    expect(await s.link('x', { type: 'item', id: 'b' })).toBe('failed');
    expect(f.writes).toHaveLength(1);
    const again = s.retry();
    await settle();
    expect(f.writes[1]!.command).toEqual(f.writes[0]!.command);
    f.writes[1]!.settle();
    expect(await again).toBe('ok');
    expect(s.needsRetry).toBe(false);
  });

  it('a version conflict is definite: the list is re-read and the command dropped', async () => {
    const f = fake([photo('x', 2)]);
    const s = session(f.api);
    await s.load();
    const r = s.link('x', { type: 'item', id: 'a' });
    await settle();
    f.set([photo('x', 3, { type: 'issue', id: 'i9' })]);
    f.writes[0]!.settle(new ApiError('VERSION_CONFLICT', 409));
    expect(await r).toBe('rejected');
    expect(s.error).toBe('VERSION_CONFLICT');
    expect(s.pending).toBeNull();
    expect(s.find('x')?.linkVersion).toBe(3);
  });

  it('discarding an upload whose outcome was unknown reads the list again', async () => {
    const f = fake();
    const s = session(f.api);
    await s.load();
    await s.addAlbum([file()], null);
    await settle();
    f.uploads[0]!.settle(new ApiError('NETWORK', 0));
    await settle();
    // It may have been stored after all.
    f.set([photo('maybe', 0)]);
    s.discard(s.jobs[0]!.key);
    await settle();
    expect(s.jobs).toEqual([]);
    expect(s.photos?.map((p) => p.id)).toEqual(['maybe']);
    expect(s.unlinked).toBe(1);
  });

  it('an idempotent replay of an old upload response never undoes a newer link, even if the refresh fails', async () => {
    const f = fake();
    const s = session(f.api);
    await s.load();
    await s.addAlbum([file()], { type: 'item', id: 'a' });
    await settle();
    // Stored, but the response was lost.
    f.uploads[0]!.settle(new ApiError('NETWORK', 0));
    await settle();
    // Meanwhile the photo was relinked (elsewhere) and that newer state was read.
    f.set([photo('x', 3, { type: 'issue', id: 'i1' })]);
    await s.load();
    expect(s.find('x')).toMatchObject({ linkVersion: 3 });
    // Retry: the server replays the original response (version 1, item a) ...
    f.manualReads(true);
    s.retryUpload(s.jobs[0]!.key);
    await settle();
    f.uploads[1]!.settle({
      ...photo('x', 1, { type: 'item', id: 'a' }),
      deduplicated: false,
    });
    await settle();
    // ... and every refresh fails.
    for (let i = 1; i <= 3; i++) {
      f.reads[i - 1]?.settle(new ApiError('NETWORK', 0));
      await settle();
    }
    expect(f.reads).toHaveLength(3);
    expect(s.find('x')).toMatchObject({
      linkVersion: 3,
      link: { type: 'issue', id: 'i1' },
    });
    expect(s.jobs).toEqual([]);
    expect(s.error).toBe('SAVED_STALE');
    // The list is not current after the write: counts are unknown, not the old ones.
    expect(s.unlinked).toBeNull();
    expect(s.photographed()).toBeNull();
  });

  it('an upload acknowledged before the first list lands stays shown; the older empty list is not applied', async () => {
    const f = fake();
    f.manualReads(true);
    const s = session(f.api);
    const first = s.load(); // started before the upload: answers "no photos"
    await s.addAlbum([file()], { type: 'item', id: 'a' });
    await settle();
    f.set([photo('u', 1, { type: 'item', id: 'a' })]);
    f.uploads[0]!.settle(stored(f.uploads[0]!.upload, 'u'));
    await settle();
    expect(s.photos?.map((p) => p.id)).toEqual(['u']);
    f.reads[0]!.settle();
    await first;
    expect(s.photos?.map((p) => p.id)).toEqual(['u']);
    // The refreshes after the upload fail: still shown, counts still unknown.
    for (let i = 1; i <= 3; i++) {
      f.reads[i]?.settle(new ApiError('NETWORK', 0));
      await settle();
    }
    expect(s.photos?.map((p) => p.id)).toEqual(['u']);
    expect(s.unlinked).toBeNull();
    expect(s.photographed()).toBeNull();
    expect(s.needsRetry).toBe(true);
    // Retry reads again; the complete list confirms it and counts become known.
    const again = s.retry();
    await settle();
    f.reads.at(-1)!.settle();
    expect(await again).toBe('ok');
    expect(s.photos?.map((p) => p.id)).toEqual(['u']);
    expect(s.unlinked).toBe(0);
    expect(s.photographed()).toEqual(new Set(['a']));
  });

  it('a failed list load is reported with a retry that reads again; counts stay unknown', async () => {
    const f = fake([photo('x', 0)]);
    f.manualReads(true);
    const s = session(f.api);
    const first = s.load();
    f.reads[0]!.settle(new ApiError('NETWORK', 0));
    await first;
    expect(s.photos).toBeNull();
    expect(s.unlinked).toBeNull();
    expect(s.needsRetry).toBe(true);
    expect(s.retryReason).toBe('LOAD_FAILED');
    const again = s.retry();
    await settle();
    expect(f.reads).toHaveLength(2);
    f.reads[1]!.settle();
    expect(await again).toBe('ok');
    expect(s.photos?.map((p) => p.id)).toEqual(['x']);
    expect(s.unlinked).toBe(1);
    expect(s.needsRetry).toBe(false);
  });
});
