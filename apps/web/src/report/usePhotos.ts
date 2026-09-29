import { useEffect, useMemo, useReducer, useRef } from 'react';
import type { PhotoLinkDto } from '@mje/contracts';
import type { ReportApi } from '../api.js';
import { locate } from './geo.js';
import { ImageCache } from './photo-images.js';
import {
  PhotoSession,
  type Capture,
  type PickedFile,
} from './photo-session.js';
import { makeThumbnail } from './thumbnail.js';

export type { UploadJob, PhotoOutcome } from './photo-session.js';

/**
 * The PhotoSession of the shown project day (one per day for the life of the workspace, as
 * useIssues), the hidden camera/album inputs and the workspace's image cache.
 */
export function usePhotos(
  api: ReportApi,
  projectId: string,
  businessDate: string,
  /** The day's state and revision: photos reload when they change. */
  dayStamp: string,
) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const images = useMemo(
    () => new ImageCache((id, which) => api.photoImage(id, which)),
    [api],
  );
  useEffect(() => () => images.dispose(), [images]);
  const sessions = useRef(new Map<string, PhotoSession>());
  const key = `${projectId}:${businessDate}`;
  let session = sessions.current.get(key);
  if (!session) {
    session = new PhotoSession(api, projectId, businessDate, rerender, {
      newId: () => crypto.randomUUID(),
      locate: () => locate(navigator.geolocation ?? null),
      thumbnail: makeThumbnail,
      now: () => new Date().toISOString(),
      uploaded: (photo, thumb) => thumb && images.seed(photo.id, thumb),
    });
    sessions.current.set(key, session);
  }
  const current = session;
  useEffect(() => {
    void current.load();
  }, [current, dayStamp]);

  // The input only reports a file; the target (session and link) is fixed when it is opened,
  // so a picture always goes to the day and item it was taken for.
  const cameraInput = useRef<HTMLInputElement | null>(null);
  const albumInput = useRef<HTMLInputElement | null>(null);
  const capture = useRef<{ session: PhotoSession; capture: Capture } | null>(
    null,
  );
  const albumFor = useRef<{
    session: PhotoSession;
    link: PhotoLinkDto | null;
  } | null>(null);

  return {
    session: current,
    images,
    photos: current.photos,
    unlinked: current.unlinked,
    access: current.access,
    jobs: current.jobs,
    busy: current.busy,
    error: current.error,
    pending: current.pending !== null,
    needsRetry: current.needsRetry,
    reload: () => current.load(),
    retry: () => current.retry(),
    link: (photoId: string, target: PhotoLinkDto | null) =>
      current.link(photoId, target),
    retryUpload: (k: string) => current.retryUpload(k),
    relocate: (k: string) => void current.relocate(k),
    discard: (k: string) => current.discard(k),
    /** Must run in the tap handler: it starts the fix and opens the camera. */
    camera: (link: PhotoLinkDto | null) => {
      capture.current = {
        session: current,
        capture: current.beginCapture(link),
      };
      cameraInput.current?.click();
    },
    album: (link: PhotoLinkDto | null) => {
      albumFor.current = { session: current, link };
      albumInput.current?.click();
    },
    inputs: {
      cameraRef: cameraInput,
      albumRef: albumInput,
      onCamera: (files: FileList | null) => {
        const file = files?.[0];
        const c = capture.current;
        capture.current = null;
        if (file && c) void c.session.addCamera(c.capture, file as PickedFile);
      },
      onAlbum: (files: FileList | null) => {
        const a = albumFor.current;
        albumFor.current = null;
        if (files?.length && a)
          void a.session.addAlbum([...files] as PickedFile[], a.link);
      },
    },
  };
}
export type PhotosHandle = ReturnType<typeof usePhotos>;
