import { useEffect, useMemo, useState } from 'react';
import type { Project, ReportApi } from '../api.js';
import { useI18n } from '../i18n.js';
import { Sheet } from '../ui.js';
import { ErrorText } from '../field/ErrorText.js';
import { fmtStamp } from '../report/format.js';
import { CheckInsCard } from './CheckIns.js';
import { DevicesCard } from './Devices.js';
import { encodeQr, qrPath } from './qr.js';
import { SettingsCards } from './Settings.js';
import { qrState, type SiteSessions } from './site-sessions.js';
import { useSessions } from './use-sessions.js';

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

/** Print only the poster: the class scopes the print CSS to this one print. */
function printPoster() {
  document.body.classList.add('print-poster');
  const done = () => {
    document.body.classList.remove('print-poster');
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
}

/**
 * The project's site QR code (PM only): one active entry code, printable, replaced by
 * rotation (design §2 "Entry code", U7). Rotating stops future reads with the old code but
 * cannot take back names already seen. A code is shown and printable only while it is known
 * to be current: after a rotation whose reread failed, the card offers a reload instead.
 */
export function EntryCodeCard({
  sessions,
  project,
  api,
}: {
  sessions: SiteSessions;
  project: Project;
  api: ReportApi;
}) {
  const { t, locale } = useI18n();
  useSessions(sessions);
  const session = sessions.entry;
  useEffect(() => void session.load(), [session]);
  const [confirming, setConfirming] = useState(false);
  const state = qrState(session);
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
  const hasCode = state.kind === 'code';
  const sheetTitle = hasCode ? 'site_rotate' : 'site_create';
  const link = hasCode ? entryLink(window.location.origin, state.code) : null;
  return (
    <section className="card qr-poster">
      <div className="blk-row">
        <h2 className="blk">{t('site_qrTitle')}</h2>
      </div>
      {session.pending && !confirming && (
        <div className="banner warn noprint" role="alert">
          {t('site_rotateUnsettled')}{' '}
          <button
            type="button"
            className="pill"
            disabled={session.busy}
            onClick={() => void rotate()}
          >
            {t('retry')}
          </button>
        </div>
      )}
      {state.kind === 'error' ? (
        <div className="banner err" role="alert">
          <ErrorText code={state.code} />
        </div>
      ) : state.kind === 'loading' ? (
        <p className="muted">{t('loading')}</p>
      ) : state.kind === 'stale' ? (
        <>
          <div className="banner warn noprint" role="alert">
            {t('site_codeStale')}
          </div>
          <button
            type="button"
            className="primary noprint"
            disabled={session.busy}
            onClick={() => void session.retry()}
          >
            {t('site_reload')}
          </button>
        </>
      ) : state.kind === 'code' && link ? (
        <>
          <p className="print-only big">{project.name}</p>
          <QrSvg text={link} label={t('site_qrTitle')} />
          <p className="para center print-only">{t('site_qrScan')}</p>
          <div className="kv">
            <span>{t('site_code')}</span>
            <span className="num code">{state.code}</span>
          </div>
          <div className="kv">
            <span>{t('site_link')}</span>
            <span className="num code">{link}</span>
          </div>
          {state.createdAt && (
            <p className="muted small noprint">
              {t('site_codeSince', {
                t: fmtStamp(state.createdAt, locale, project.timezone),
              })}
            </p>
          )}
          <p className="muted small noprint">{t('site_qrNames')}</p>
          <div className="row2 noprint">
            <button
              type="button"
              className="primary"
              disabled={session.pending !== null}
              onClick={printPoster}
            >
              {t('site_print')}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={session.pending !== null}
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
            disabled={session.pending !== null}
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
          {hasCode && <p className="para">{t('site_rotateWarn')}</p>}
          <p className="para muted small">{t('site_qrNames')}</p>
          {session.error && session.error !== 'STALE' && (
            <div className="banner err" role="alert">
              <ErrorText
                code={session.error}
                write
                uncertain={session.errorUncertain}
              />
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

/**
 * The PM's people page (人员): phones waiting for confirmation first, then the site QR code,
 * the site location and field settings. Writers only; a reader never gets it (OD20). The
 * sessions come from the workspace, so leaving the tab keeps unresolved commands.
 */
export function SitePage({
  api,
  project,
  sessions,
  date,
  headcount,
}: {
  api: ReportApi;
  project: Project;
  sessions: SiteSessions;
  date: string;
  headcount: string | null;
}) {
  return (
    <>
      <DevicesCard sessions={sessions} project={project} />
      <CheckInsCard
        api={api}
        project={project}
        sessions={sessions}
        date={date}
        headcount={headcount}
      />
      <EntryCodeCard sessions={sessions} project={project} api={api} />
      <SettingsCards sessions={sessions} project={project} api={api} />
    </>
  );
}
