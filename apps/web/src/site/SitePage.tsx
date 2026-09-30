import { useEffect, useMemo, useReducer, useState } from 'react';
import type { EntryCodeDto } from '@mje/contracts';
import type { Project, ReportApi } from '../api.js';
import { useI18n } from '../i18n.js';
import { Sheet } from '../ui.js';
import { ErrorText } from '../field/ErrorText.js';
import { FieldSession } from '../field/session.js';
import { fmtStamp } from '../report/format.js';
import { encodeQr, qrPath } from './qr.js';

/** The link a site QR code carries; the code stays in the fragment (never sent in a URL). */
export function entryLink(origin: string, code: string): string {
  return `${origin}/field/#e=${code}`;
}

function QrSvg({ text, label }: { text: string; label: string }) {
  const m = useMemo(() => encodeQr(text), [text]);
  const n = m.length + 8;
  return (
    <svg
      className="qr"
      viewBox={`0 0 ${n} ${n}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={n} height={n} fill="#fff" />
      <path d={qrPath(m)} fill="#000" />
    </svg>
  );
}

/**
 * The project's site QR code (PM only): one active entry code, printable, replaced by
 * rotation (design §2 "Entry code", U7). Rotating stops future reads with the old code but
 * cannot take back names already seen.
 */
export function EntryCodeCard({
  api,
  project,
}: {
  api: ReportApi;
  project: Project;
}) {
  const { t, locale } = useI18n();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [session] = useState(
    () =>
      new FieldSession<EntryCodeDto>(() => api.entryCode(project.id), rerender),
  );
  useEffect(() => void session.load(), [session]);
  const [confirming, setConfirming] = useState(false);
  const data = session.data;
  const rotate = async () => {
    const r = session.pending
      ? await session.retry()
      : await session.act(() => {
          const c = {
            projectId: project.id,
            clientMutationId: crypto.randomUUID(),
          };
          return {
            key: c.clientMutationId,
            send: () => api.rotateEntryCode(c),
          };
        });
    if (r.kind === 'ok') setConfirming(false);
  };
  const sheetTitle = data?.code ? 'site_rotate' : 'site_create';
  const link = data?.code ? entryLink(window.location.origin, data.code) : null;
  return (
    <section className="card qr-poster">
      <div className="blk-row">
        <h2 className="blk">{t('site_qrTitle')}</h2>
      </div>
      {session.readError && !data ? (
        <div className="banner err" role="alert">
          <ErrorText code={session.readError} />
        </div>
      ) : !data ? (
        <p className="muted">{t('loading')}</p>
      ) : link && data.code ? (
        <>
          <p className="print-only big">{project.name}</p>
          <QrSvg text={link} label={t('site_qrTitle')} />
          <p className="para center print-only">{t('site_qrScan')}</p>
          <div className="kv">
            <span>{t('site_code')}</span>
            <span className="num code">{data.code}</span>
          </div>
          <div className="kv">
            <span>{t('site_link')}</span>
            <span className="num code">{link}</span>
          </div>
          {data.createdAt && (
            <p className="muted small noprint">
              {t('site_codeSince', {
                t: fmtStamp(data.createdAt, locale, project.timezone),
              })}
            </p>
          )}
          <p className="muted small noprint">{t('site_qrNames')}</p>
          <div className="row2 noprint">
            <button
              type="button"
              className="primary"
              onClick={() => window.print()}
            >
              {t('site_print')}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => setConfirming(true)}
            >
              {t('site_rotate')}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="para">{t('site_noCode')}</p>
          <button
            type="button"
            className="primary noprint"
            onClick={() => setConfirming(true)}
          >
            {t('site_create')}
          </button>
        </>
      )}
      {confirming && (
        <Sheet
          title={t(sheetTitle)}
          onClose={() => !session.busy && setConfirming(false)}
        >
          {data?.code && <p className="para">{t('site_rotateWarn')}</p>}
          <p className="para muted small">{t('site_qrNames')}</p>
          {session.error && (
            <div className="banner err" role="alert">
              <ErrorText code={session.error} />
            </div>
          )}
          <button
            type="button"
            className="primary wide"
            disabled={session.busy}
            onClick={() => void rotate()}
          >
            {session.pending ? t('retry') : t('site_rotateConfirm')}
          </button>
        </Sheet>
      )}
    </section>
  );
}

/** The PM's site page: the entry QR code (A6d-1); devices and settings follow. */
export function SitePage({
  api,
  project,
}: {
  api: ReportApi;
  project: Project;
}) {
  return <EntryCodeCard api={api} project={project} />;
}
