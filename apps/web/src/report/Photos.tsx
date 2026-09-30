import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type {
  PhotoAsOfDto,
  PhotoDto,
  PhotoLinkDto,
  ReportItemDto,
} from '@mje/contracts';
import type { MessageKey } from '@mje/ui';
import { useI18n } from '../i18n.js';
import { Icon } from '../icons.js';
import { Chip, Kv, Sheet } from '../ui.js';
import { fmtFileLocal, fmtNum, fmtStamp } from './format.js';
import { photoAsOf } from './model.js';
import type { ImageKind } from './photo-images.js';
import type { UploadJob } from './photo-session.js';
import type { PhotosHandle } from './usePhotos.js';

/**
 * The message for a photo error. Only known codes get their own text; anything else (a code
 * the client does not know, or text that is not a code) is shown as the generic failure.
 */
export function photoErrorKey(code: string | null): MessageKey | null {
  switch (code) {
    case null:
      return null;
    case 'PHOTO_TOO_LARGE':
      return 'photoTooLarge';
    case 'UNSUPPORTED_MEDIA':
      return 'photoUnsupported';
    case 'PHOTO_ELSEWHERE':
      return 'photoElsewhere';
    case 'NEEDS_LOCATION':
      return 'photoNotSent';
    case 'denied':
      return 'locDenied';
    case 'noFix':
      return 'locNoFix';
    case 'unsupported':
      return 'locUnsupported';
    case 'LOCKED':
      return 'locked';
    case 'READ_ONLY':
    case 'FORBIDDEN':
      return 'forbidden';
    case 'VERSION_CONFLICT':
      return 'conflictReloaded';
    case 'CONFLICT_STALE':
      return 'conflictStale';
    case 'STALE':
      return 'photosStale';
    case 'SAVED_STALE':
      return 'photosSavedStale';
    case 'LOAD_FAILED':
      return 'loadFail';
    case 'PENDING':
      return 'saveFail';
    default:
      return 'saveFail';
  }
}

interface IssueRef {
  id: string;
  title: string;
  status: 'open' | 'closed';
}
export interface PhotoEnv {
  handle: PhotosHandle;
  /** Active work items: link choices and labels. */
  items: ReportItemDto[];
  issues: IssueRef[];
  /** Project write access: link, unlink. */
  canWrite: boolean;
  /** Write access on a day that takes uploads (not submitted, nothing running). */
  canUpload: boolean;
  timeZone: string;
}
interface PhotoCtx extends PhotoEnv {
  view: (photo: PhotoAsOfDto, live: boolean) => void;
  gallery: () => void;
}
const Ctx = createContext<PhotoCtx | null>(null);
function usePhotoEnv(): PhotoCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('PhotoHost missing');
  return v;
}

/** An object URL for the image while mounted; revoked by the cache after the last user. */
function useImageUrl(id: string, which: ImageKind) {
  const { handle } = usePhotoEnv();
  const images = handle.images;
  const [got, setGot] = useState<{
    key: string;
    url: string | null;
  } | null>(null);
  const key = `${which}:${id}`;
  useEffect(() => {
    let live = true;
    void images.acquire(id, which).then((url) => {
      if (live) setGot({ key, url });
    });
    return () => {
      live = false;
      images.release(id, which);
    };
  }, [images, id, which, key]);
  return got?.key === key
    ? { url: got.url, done: true }
    : { url: null, done: false };
}

function useLinkText() {
  const { t, label } = useI18n();
  const env = usePhotoEnv();
  return (link: PhotoLinkDto | null) => {
    if (!link) return t('unlinked');
    if (link.type === 'item') {
      const it = env.items.find((i) => i.key === link.id);
      return it ? label(it.label) : link.id;
    }
    return env.issues.find((i) => i.id === link.id)?.title ?? t('issues');
  };
}

/**
 * Whether the photo has a position and how precise its fix claims to be; never where (a reader
 * gets no coordinates at all, OD20). A reader's tag is neutral: a position is not a verification.
 */
function LocTag({ photo }: { photo: PhotoAsOfDto }) {
  const { t, locale } = useI18n();
  const { canWrite } = usePhotoEnv();
  if (photo.location === 'device')
    return (
      <span className={canWrite ? 'ptag ok' : 'ptag'}>
        <Icon.pin />
        {photo.accuracyM
          ? `±${fmtNum(photo.accuracyM, locale)} ${t('u_m')}`
          : null}
      </span>
    );
  if (photo.location === 'file')
    return <span className="ptag">{t('fileLocation')}</span>;
  return <span className="ptag warn">{t('noLocation')}</span>;
}

function Tile({
  photo,
  n,
  small,
  live,
}: {
  photo: PhotoAsOfDto;
  n: number;
  small?: boolean;
  live: boolean;
}) {
  const { t } = useI18n();
  const env = usePhotoEnv();
  const img = useImageUrl(photo.id, 'thumbnail');
  return (
    <button
      type="button"
      className="phbtn"
      aria-label={t('photoN', { n })}
      onClick={() => env.view(photo, live)}
    >
      <span
        className={`ph${small ? ' sm' : ''}`}
        style={img.url ? { backgroundImage: `url("${img.url}")` } : undefined}
      >
        {!img.url && img.done && (
          <span className="ph-none">
            <Icon.image />
          </span>
        )}
        {!small && <LocTag photo={photo} />}
      </span>
    </button>
  );
}

/** A photo on its way: its own state, one line, with the action that state allows. */
function JobRow({ job }: { job: UploadJob }) {
  const { t } = useI18n();
  const { handle } = usePhotoEnv();
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!job.thumb) return;
    const url = URL.createObjectURL(job.thumb);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [job.thumb]);
  const discard = (
    <button
      type="button"
      className="pill"
      onClick={() => handle.discard(job.key)}
    >
      {t('discard')}
    </button>
  );
  let text: string;
  let tone = '';
  let actions: ReactNode = null;
  const reason: MessageKey = photoErrorKey(job.error) ?? 'saveFail';
  const noFix: MessageKey = photoErrorKey(job.error) ?? 'locNoFix';
  switch (job.state) {
    case 'locating':
      text = t('locating');
      break;
    case 'queued':
      text = t('uploadWaiting');
      break;
    case 'sending':
      text = t('uploading', { p: job.progress });
      break;
    case 'noLocation':
      text = `${t('photoNotSent')} · ${t(noFix)}`;
      tone = ' warn';
      actions = (
        <>
          <button
            type="button"
            className="pill accent"
            onClick={() => handle.relocate(job.key)}
          >
            {t('retryLocation')}
          </button>
          {discard}
        </>
      );
      break;
    case 'failed':
      text = t('uploadFailed');
      tone = ' err';
      actions = (
        <>
          <button
            type="button"
            className="pill accent"
            onClick={() => handle.retryUpload(job.key)}
          >
            {t('retry')}
          </button>
          {discard}
        </>
      );
      break;
    case 'rejected':
      text = t(reason);
      tone = ' err';
      actions = discard;
      break;
  }
  return (
    <div className={`job${tone}`}>
      {job.thumb && preview && (
        <span
          className="ph sm"
          style={{ backgroundImage: `url("${preview}")` }}
        />
      )}
      <span className="grow small" role="status">
        {text}
        {job.state === 'sending' && (
          <progress max={100} value={job.progress} aria-hidden="true" />
        )}
      </span>
      {actions && <span className="chips">{actions}</span>}
    </div>
  );
}

/** Link-command trouble: unsent command or stale list (Retry), else the last rejection. */
function PhotoBanner() {
  const { t } = useI18n();
  const { handle } = usePhotoEnv();
  if (handle.retryReason) {
    const key = photoErrorKey(handle.retryReason);
    return (
      <div className="banner err">
        {key ? t(key) : null}{' '}
        <button
          type="button"
          className="pill"
          disabled={handle.busy}
          onClick={() => void handle.retry()}
        >
          {t('retry')}
        </button>
      </div>
    );
  }
  const key = handle.error === 'NETWORK' ? null : photoErrorKey(handle.error);
  return key ? <div className="banner warn">{t(key)}</div> : null;
}

function UploadButtons({
  link,
  id,
  big,
}: {
  link: PhotoLinkDto | null;
  id?: string | undefined;
  big?: boolean;
}) {
  const { t } = useI18n();
  const { handle } = usePhotoEnv();
  const cls = big ? 'ghost small' : 'pill';
  return (
    <>
      <button
        id={id}
        type="button"
        className={cls}
        onClick={() => handle.camera(link)}
      >
        <Icon.camera /> {t('takePhoto')}
      </button>
      <button type="button" className={cls} onClick={() => handle.album(link)}>
        {t('fromAlbum')}
      </button>
    </>
  );
}

/** Photos under one work item or issue in the form: current links, uploads, add buttons. */
export function PhotoLine({
  link,
  buttonId,
}: {
  link: PhotoLinkDto;
  buttonId?: string | undefined;
}) {
  const env = usePhotoEnv();
  const photos = env.handle.session.linked(link.type, link.id);
  const jobs = env.handle.session.jobsFor(link);
  if (!photos.length && !jobs.length && !env.canUpload) return null;
  return (
    <>
      <div className="qphotos">
        {photos.map((p, i) => (
          <Tile key={p.id} photo={photoAsOf(p)} n={i + 1} small live />
        ))}
        {env.canUpload && <UploadButtons link={link} id={buttonId} />}
      </div>
      {jobs.map((j) => (
        <JobRow key={j.key} job={j} />
      ))}
    </>
  );
}

/** Photos under a work item or issue in the report, as given (a submitted day: frozen). */
export function ReportPhotos({
  photos,
  type,
  id,
}: {
  photos: PhotoAsOfDto[];
  type: PhotoLinkDto['type'];
  id: string;
}) {
  const list = photos.filter((p) => p.link?.type === type && p.link.id === id);
  if (!list.length) return null;
  return (
    <div className="qphotos">
      {list.map((p, i) => (
        <Tile key={p.id} photo={p} n={i + 1} small live={false} />
      ))}
    </div>
  );
}

/** Photos in a row, whatever they back (the report's photos without a place of their own). */
export function PhotoStrip({ photos }: { photos: PhotoAsOfDto[] }) {
  return (
    <div className="qphotos">
      {photos.map((p, i) => (
        <Tile key={p.id} photo={p} n={i + 1} small live={false} />
      ))}
    </div>
  );
}

/** The form's photo card: add without a link, unlinked photos and the way to link them. */
export function PhotosCard() {
  const { t } = useI18n();
  const env = usePhotoEnv();
  const { photos, counts } = env.handle;
  const unlinked = (photos ?? []).filter((p) => !p.link);
  const jobs = env.handle.session.jobsFor(null);
  // Counts only from a complete list: while reads after a write fail, the photos known are
  // shown but not counted (a partial count would read as the day's total).
  return (
    <section className="card">
      <div className="blk-row">
        <h2 className="blk">
          {t('photos')}{' '}
          {counts && <span className="muted">{counts.total}</span>}
        </h2>
        {env.canUpload && (
          <div className="chips">
            <UploadButtons link={null} big />
          </div>
        )}
      </div>
      <PhotoBanner />
      {photos === null && !env.handle.loadFailed && (
        <p className="muted small">{t('loading')}</p>
      )}
      {unlinked.length > 0 && (
        <>
          <span className="muted small">
            {counts ? t('unlinkedN', { n: counts.noLink }) : t('unlinked')}
          </span>
          <div className="qphotos">
            {unlinked.map((p, i) => (
              <Tile key={p.id} photo={photoAsOf(p)} n={i + 1} small live />
            ))}
          </div>
        </>
      )}
      {jobs.map((j) => (
        <JobRow key={j.key} job={j} />
      ))}
      {photos && photos.length > 0 && (
        <button type="button" className="linkrow" onClick={env.gallery}>
          <span className="grow">
            {env.canWrite ? t('linkPhotos') : t('photos')}
          </span>
          <Icon.right />
        </button>
      )}
    </section>
  );
}

/** The report's photo row (current photos; opens the list where they are linked). */
export function PhotosRow() {
  const { t } = useI18n();
  const env = usePhotoEnv();
  const { photos, unlinked, counts } = env.handle;
  // The list could not be read: say so with a retry rather than hide the photos.
  if (!photos)
    return env.handle.loadFailed ? (
      <section className="card">
        <PhotoBanner />
      </section>
    ) : null;
  return (
    <button type="button" className="card rowbtn" onClick={env.gallery}>
      <span className="grow">
        <b>{t('photos')}</b>{' '}
        <span className="muted">
          {/* Not counted from a partial list (see PhotosCard). */}
          {counts ? counts.total : ''}
          {unlinked ? ` · ${t('unlinkedN', { n: unlinked })}` : ''}
        </span>
      </span>
      <Icon.right />
    </button>
  );
}

/**
 * Before submitting: unlinked photos are not submitted evidence. A reminder only (rule 5);
 * nothing here blocks the submission. Unknown (not loaded) shows nothing rather than 0.
 */
export function UnlinkedReminder() {
  const { t } = useI18n();
  const env = usePhotoEnv();
  const n = env.handle.unlinked;
  if (!n) return null;
  return (
    <div className="banner warn">
      {t('unlinkedReminder', { n })}{' '}
      {env.canWrite && (
        <button type="button" className="pill" onClick={env.gallery}>
          {t('linkPhotos')}
        </button>
      )}
    </div>
  );
}

function LinkSelect({ photo }: { photo: PhotoDto }) {
  const { t, label } = useI18n();
  const env = usePhotoEnv();
  const { handle } = env;
  const value = photo.link ? `${photo.link.type}:${photo.link.id}` : '';
  const items = env.items;
  const staleItem =
    photo.link?.type === 'item' && !items.some((i) => i.key === photo.link?.id)
      ? photo.link.id
      : null;
  const issues = env.issues.filter(
    (i) =>
      i.status === 'open' ||
      (photo.link?.type === 'issue' && photo.link.id === i.id),
  );
  return (
    <label className="field">
      <span>{t('linkTo')}</span>
      <select
        value={value}
        disabled={handle.busy || handle.pending}
        onChange={(e) => {
          const v = e.target.value;
          const at = v.indexOf(':');
          const type = v.slice(0, at);
          const target: PhotoLinkDto | null =
            at > 0 && (type === 'item' || type === 'issue')
              ? { type, id: v.slice(at + 1) }
              : null;
          void handle.link(photo.id, target);
        }}
      >
        <option value="">{t('unlinked')}</option>
        <optgroup label={t('progress')}>
          {items.map((i) => (
            <option key={i.key} value={`item:${i.key}`}>
              {label(i.label)}
            </option>
          ))}
          {staleItem && (
            <option value={`item:${staleItem}`}>{staleItem}</option>
          )}
        </optgroup>
        {issues.length > 0 && (
          <optgroup label={t('issues')}>
            {issues.map((i) => (
              <option key={i.id} value={`issue:${i.id}`}>
                {i.title}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}

/** What the photo claims: source, where the position came from, and the clocks it carries. */
function PhotoMeta({
  photo,
  fixAt,
}: {
  photo: PhotoAsOfDto;
  fixAt: string | null;
}) {
  const { t, locale } = useI18n();
  const { timeZone, canWrite } = usePhotoEnv();
  const lines = [
    photo.location === 'device'
      ? [
          photo.accuracyM
            ? canWrite
              ? t('located', { m: fmtNum(photo.accuracyM, locale) })
              : // OD20: a reader learns that there is a position and its accuracy, not where.
                t('hasLocation', { m: fmtNum(photo.accuracyM, locale) })
            : null,
          fixAt ? t('fixAt', { t: fmtStamp(fixAt, locale, timeZone) }) : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : photo.location === 'file'
        ? t('fileLocation')
        : t('noLocation'),
    photo.deviceCapturedAt
      ? t('deviceTime', {
          t: fmtStamp(photo.deviceCapturedAt, locale, timeZone),
        })
      : null,
    photo.fileTakenLocal
      ? t('fileTime', { t: fmtFileLocal(photo.fileTakenLocal) })
      : null,
  ].filter((l): l is string => Boolean(l));
  return (
    <>
      <div className="chips">
        <Chip>
          {photo.source === 'camera' ? t('srcCamera') : t('srcAlbum')}
        </Chip>
      </div>
      {lines.map((l, i) => (
        <p
          className={
            i === 0 && photo.location === 'none'
              ? 'warn-t small'
              : 'muted small'
          }
          key={l}
        >
          {l}
        </p>
      ))}
    </>
  );
}

function ViewerSheet({
  photo,
  live,
  onClose,
}: {
  photo: PhotoAsOfDto;
  live: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const env = usePhotoEnv();
  const linkText = useLinkText();
  const current = live ? env.handle.session.find(photo.id) : null;
  const shown = current ? photoAsOf(current) : photo;
  const full = useImageUrl(photo.id, 'photo');
  const thumb = useImageUrl(photo.id, 'thumbnail');
  const [broken, setBroken] = useState(false);
  const src = !broken && full.url ? full.url : thumb.url;
  return (
    <Sheet title={t('photos')} onClose={onClose}>
      {src ? (
        <img
          className="phview"
          src={src}
          alt={t('photos')}
          onError={() => setBroken(true)}
        />
      ) : (
        <p className="muted">
          {full.done && thumb.done ? t('imageUnavailable') : t('loading')}
        </p>
      )}
      <PhotoMeta photo={shown} fixAt={current?.capture?.fixAt ?? null} />
      {current && env.canWrite ? (
        <LinkSelect photo={current} />
      ) : (
        <Kv label={t('linkTo')}>{linkText(shown.link)}</Kv>
      )}
    </Sheet>
  );
}

function GallerySheet({ onClose }: { onClose: () => void }) {
  const { t, locale } = useI18n();
  const env = usePhotoEnv();
  const linkText = useLinkText();
  const photos = env.handle.photos ?? [];
  return (
    <Sheet title={t('photos')} onClose={onClose}>
      <PhotoBanner />
      {env.handle.jobs.map((j) => (
        <JobRow key={j.key} job={j} />
      ))}
      {env.handle.photos === null
        ? !env.handle.loadFailed && <p className="muted">{t('loading')}</p>
        : photos.length === 0 && <p className="muted">{t('none')}</p>}
      <div className="grid2">
        {photos.map((p, i) => (
          <figure key={p.id}>
            <Tile photo={photoAsOf(p)} n={i + 1} live />
            {env.canWrite ? (
              <LinkSelect photo={p} />
            ) : (
              <span className="small">{linkText(p.link)}</span>
            )}
            <figcaption className="muted small">
              {[
                p.source === 'camera' ? t('srcCamera') : t('srcAlbum'),
                p.deviceCapturedAt
                  ? fmtStamp(p.deviceCapturedAt, locale, env.timeZone)
                  : p.file.takenLocal
                    ? t('fileTime', { t: fmtFileLocal(p.file.takenLocal) })
                    : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </figcaption>
          </figure>
        ))}
      </div>
    </Sheet>
  );
}

/**
 * Provides photos to the screens below it and hosts what they open: the photo viewer, the
 * photo list, and the hidden camera and album inputs (in-app capture uses the rear camera).
 */
export function PhotoHost({
  env,
  children,
}: {
  env: PhotoEnv;
  children: ReactNode;
}) {
  const [viewing, setViewing] = useState<{
    photo: PhotoAsOfDto;
    live: boolean;
  } | null>(null);
  const [gallery, setGallery] = useState(false);
  const { inputs } = env.handle;
  const value: PhotoCtx = {
    ...env,
    view: (photo, live) => setViewing({ photo, live }),
    gallery: () => setGallery(true),
  };
  return (
    <Ctx.Provider value={value}>
      {children}
      <input
        ref={inputs.cameraRef}
        className="vh"
        type="file"
        accept="image/*"
        capture="environment"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          inputs.onCamera(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
      />
      <input
        ref={inputs.albumRef}
        className="vh"
        type="file"
        accept="image/*"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          inputs.onAlbum(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
      />
      {gallery && <GallerySheet onClose={() => setGallery(false)} />}
      {viewing && (
        <ViewerSheet
          key={viewing.photo.id}
          photo={viewing.photo}
          live={viewing.live}
          onClose={() => setViewing(null)}
        />
      )}
    </Ctx.Provider>
  );
}

/** For screens that may render outside a PhotoHost (nothing is shown then). */
export function usePhotosAvailable(): boolean {
  return useContext(Ctx) !== null;
}
