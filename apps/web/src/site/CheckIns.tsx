import { useEffect, useState } from 'react';
import {
  PROXY_REASON_MAX,
  PROXY_SOURCES,
  type CheckInRowDto,
  type FixInput,
  type ProxySource,
} from '@mje/contracts';
import type { Project, ReportApi } from '../api.js';
import { useI18n } from '../i18n.js';
import { Sheet } from '../ui.js';
import { ErrorText } from '../field/ErrorText.js';
import { FlagChips, KindText } from '../field/CheckInCard.js';
import { fmtDay, fmtTime, siteToday } from '../report/format.js';
import { locate } from '../report/geo.js';
import { checkProxy, membersOfDay, proxyDays } from './proxy-rules.js';
import { startProxy, type SiteSessions } from './site-sessions.js';
import { useSessions } from './use-sessions.js';

const SOURCE_LABEL = {
  OBSERVED_ON_SITE: 'ci_src_OBSERVED_ON_SITE',
  FOREMAN_REPORTED: 'ci_src_FOREMAN_REPORTED',
  OTHER: 'ci_src_OTHER',
} as const;

/**
 * The day's check-ins beside the report's declared headcount (U8): the two are shown side by
 * side and a check-in never fills the headcount. Present = distinct people with a check-in;
 * it is not "on site now", hours or verified. PM proxy for the lookback days (C24).
 */
export function CheckInsCard({
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
  /** The report's declared people total for the day, or null when none is declared. */
  headcount: string | null;
}) {
  const { t, locale } = useI18n();
  useSessions(sessions);
  const day = sessions.checkIns(date);
  useEffect(() => void day.list.load(), [day.list]);
  const [proxying, setProxying] = useState(false);
  const data = day.list.data;
  const tz = project.timezone;
  return (
    <section className="card noprint">
      <div className="blk-row">
        <h2 className="blk">{t('ci_title', { d: fmtDay(date, locale) })}</h2>
        <button
          type="button"
          className="textbtn"
          onClick={() => void day.list.load()}
        >
          {t('pm_reload')}
        </button>
      </div>
      <div className="side">
        <div>
          <span className="muted small">{t('ci_present')}</span>
          <b className="num big">{data ? data.summary.present : '—'}</b>
          {data && (
            <span className="muted small">
              {t('ci_split', {
                s: data.summary.self,
                p: data.summary.proxy,
                f: data.summary.flagged,
              })}
            </span>
          )}
        </div>
        <div>
          <span className="muted small">{t('ci_headcount')}</span>
          <b className="num big">{headcount ?? '—'}</b>
          <span className="muted small">{t('ci_headcountNote')}</span>
        </div>
      </div>
      <p className="muted small">{t('ci_note')}</p>
      {day.list.readError && (
        <div className="banner err" role="alert">
          <ErrorText code={day.list.readError} />
        </div>
      )}
      {data && data.checkIns.length === 0 && (
        <p className="muted small">{t('ci_none')}</p>
      )}
      {data && data.checkIns.length > 0 && (
        <ul className="plainlist">
          {data.checkIns.map((c) => (
            <CheckInRow key={c.checkInId} c={c} tz={tz} />
          ))}
        </ul>
      )}
      <button type="button" className="ghost" onClick={() => setProxying(true)}>
        {sessions.ownedProxy()?.proxy.unresolved
          ? t('ci_proxyUnresolved')
          : t('ci_proxy')}
      </button>
      {proxying && (
        <ProxySheet
          api={api}
          project={project}
          sessions={sessions}
          date={date}
          onClose={() => setProxying(false)}
        />
      )}
    </section>
  );
}

function CheckInRow({ c, tz }: { c: CheckInRowDto; tz: string }) {
  const { t, locale } = useI18n();
  return (
    <li className={`devrow${c.voided ? ' voided' : ''}`}>
      <span className="grow">
        <b>{c.displayName}</b>
        <span className="muted small">
          {c.occurredAt && c.timePrecision === 'EXACT'
            ? fmtTime(c.occurredAt, locale, tz)
            : t('ci_wholeDay')}{' '}
          · <KindText kind={c.kind} />
          {c.distanceM !== null && ` · ${t('ci_distance', { m: c.distanceM })}`}
        </span>
        {(c.flags.length > 0 ||
          c.afterSubmission ||
          c.selfie !== 'NONE' ||
          c.voided) && (
          <span className="chips">
            <FlagChips flags={c.flags} />
            {c.afterSubmission && (
              <span className="chip">{t('ci_afterSubmission')}</span>
            )}
            {c.selfie === 'ATTACHED' && (
              <span className="chip">{t('fd_withSelfie')}</span>
            )}
            {c.selfie === 'DELETED' && (
              <span className="chip">{t('ci_selfieDeleted')}</span>
            )}
            {c.voided && (
              <span className="chip warn">
                {t('ci_voided', { r: c.voided.reason })}
              </span>
            )}
          </span>
        )}
      </span>
    </li>
  );
}

/**
 * A PM proxy check-in (design §3, C23): a person on the roster that day, a date within the
 * lookback, an optional time (none = the whole day, DAY precision, never invented), the
 * source, and a reason when required. The PM may attach their own location; it is stored as
 * the actor's and never as the worker's. Form state = the owned command's payload (C51):
 * while a proxy is running or unresolved only that payload is shown, read-only.
 */
export function ProxySheet(props: {
  api: ReportApi;
  project: Project;
  sessions: SiteSessions;
  date: string;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  // The owner of the day the proxy is for (its businessDate), whatever page date is open.
  const cmds = props.sessions.proxySheetOwner(props.date).proxy;
  const sent = cmds.current;
  if (!sent)
    return (
      <ProxyEdit
        key={cmds.generation}
        {...props}
        // One source for a first send's and a Retry's refusal: the owner (OwnedCommands).
        refusal={
          cmds.refusal
            ? { code: cmds.refusal, uncertain: cmds.refusalUncertain }
            : null
        }
      />
    );
  const tz = props.project.timezone;
  const unresolved = cmds.unresolved !== null;
  const busy = cmds.session.busy;
  const name =
    props.sessions.roster.data?.assignments.find(
      (a) => a.personId === sent.personId,
    )?.displayName ?? '—';
  const sourceKey = SOURCE_LABEL[sent.source];
  return (
    <Sheet title={t('ci_proxy')} onClose={() => !busy && props.onClose()}>
      <div className="kv">
        <span>{t('ci_person')}</span>
        <span>{name}</span>
      </div>
      <div className="kv">
        <span>{t('date')}</span>
        <span>{fmtDay(sent.businessDate, locale)}</span>
      </div>
      <div className="kv">
        <span>{t('ci_time')}</span>
        <span>
          {sent.occurredAt
            ? fmtTime(sent.occurredAt, locale, tz)
            : t('ci_wholeDay')}
        </span>
      </div>
      <div className="kv">
        <span>{t('ci_source')}</span>
        <span>{t(sourceKey)}</span>
      </div>
      {sent.reason && <p className="para small">{sent.reason}</p>}
      {sent.actorFix && <p className="muted small">{t('ci_fixNote')}</p>}
      {unresolved ? (
        <div className="banner warn" role="alert">
          {t('pm_saveUnresolved')}{' '}
          <ErrorText code={cmds.session.error ?? 'NETWORK'} write />
        </div>
      ) : (
        <p className="muted small">{t('saving')}</p>
      )}
      {unresolved && (
        <div className="row2">
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => cmds.discard()}
          >
            {t('pm_giveUp')}
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() =>
              // A refusal ends ownership; the edit form then shows it (from the owner).
              void cmds.retry().then((r) => {
                if (r.kind === 'ok') props.onClose();
              })
            }
          >
            {t('retry')}
          </button>
        </div>
      )}
    </Sheet>
  );
}

function ProxyEdit({
  api,
  project,
  sessions,
  date,
  onClose,
  refusal,
}: {
  api: ReportApi;
  project: Project;
  sessions: SiteSessions;
  date: string;
  onClose: () => void;
  refusal: { code: string; uncertain: boolean } | null;
}) {
  const { t, locale } = useI18n();
  const tz = project.timezone;
  const today = siteToday(tz);
  const days = sessions.settings.data?.settings.pmProxyDays ?? 7;
  const allowed = proxyDays(today, days);
  // A new proxy may start only when none is owned, for any day.
  const owned = sessions.ownedProxy();
  const [businessDate, setDate] = useState(
    allowed.includes(date) ? date : today,
  );
  const [personId, setPerson] = useState('');
  const [time, setTime] = useState('');
  const [source, setSource] = useState<ProxySource>('OBSERVED_ON_SITE');
  const [reason, setReason] = useState('');
  const [fix, setFix] = useState<FixInput | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<{
    code: string;
    uncertain: boolean;
  } | null>(refusal);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    void sessions.roster.load();
    if (!sessions.settings.data) void sessions.settings.load();
  }, [sessions]);
  const locked =
    owned !== null || !sessions.checkIns(businessDate).proxy.canStart;
  const people = sessions.roster.data
    ? membersOfDay(sessions.roster.data, businessDate, tz)
    : [];
  const [locating, setLocating] = useState(false);
  const takeFix = async () => {
    setNote(null);
    setLocating(true);
    const r = await locate(navigator.geolocation);
    setLocating(false);
    // A fix that arrives once a proxy is owned is dropped (this form is not shown then).
    if (sessions.ownedProxy()) return;
    if (!r.fix) {
      const key =
        r.reason === 'denied'
          ? 'locDenied'
          : r.reason === 'unsupported'
            ? 'locUnsupported'
            : 'locNoFix';
      setNote(t(key));
      return;
    }
    setFix(r.fix);
    setNote(t('located', { m: Math.round(Number(r.fix.accuracyM)) }));
  };
  const send = async () => {
    setError(null);
    setProblem(null);
    const check = checkProxy(
      { personId, businessDate, time, source, reason, actorFix: fix },
      {
        projectId: project.id,
        today,
        pmProxyDays: days,
        timeZone: tz,
        now: Date.now(),
      },
    );
    if (!check.ok) return setProblem(check.problem);
    // Owned by the day it is for (startProxy): opening that day shows it.
    const started = startProxy(sessions, api, check.command);
    if (!started) return;
    const r = await started;
    // A lost answer: the sheet now shows the owned payload (ProxySheet).
    if (r.kind === 'ok') onClose();
    else if (r.kind === 'rejected')
      setError({ code: r.code, uncertain: r.uncertain });
  };
  const problemKey =
    problem === 'person'
      ? 'ci_pickPerson'
      : problem === 'date'
        ? 'ci_dateRange'
        : problem === 'time'
          ? 'ci_timeInvalid'
          : problem === 'future'
            ? 'fe_timeOrder'
            : 'fe_reasonRequired';
  return (
    <Sheet
      title={t('ci_proxy')}
      onClose={() => !owned?.proxy.session.busy && onClose()}
    >
      <label className="field">
        <span>{t('ci_date', { n: days })}</span>
        <select
          value={businessDate}
          disabled={locked}
          onChange={(e) => {
            setDate(e.target.value);
            setPerson('');
          }}
        >
          {allowed.map((d) => (
            <option key={d} value={d}>
              {fmtDay(d, locale)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t('ci_person')}</span>
        <select
          value={personId}
          disabled={locked}
          onChange={(e) => setPerson(e.target.value)}
        >
          <option value="">—</option>
          {people.map((p) => (
            <option key={p.personId} value={p.personId}>
              {p.displayName}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t('ci_time')}</span>
        <input
          type="time"
          value={time}
          readOnly={locked}
          onChange={(e) => setTime(e.target.value)}
        />
        <span className="muted small">{t('ci_timeNote')}</span>
      </label>
      <label className="field">
        <span>{t('ci_source')}</span>
        <select
          value={source}
          disabled={locked}
          onChange={(e) => setSource(e.target.value as ProxySource)}
        >
          {PROXY_SOURCES.map((s) => {
            const key = SOURCE_LABEL[s];
            return (
              <option key={s} value={s}>
                {t(key)}
              </option>
            );
          })}
        </select>
      </label>
      <label className="field">
        <span>{t('ci_reason')}</span>
        <textarea
          rows={2}
          maxLength={PROXY_REASON_MAX}
          value={reason}
          readOnly={locked}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="ghost"
        disabled={locked || locating}
        onClick={() => void takeFix()}
      >
        {fix ? t('ci_fixAgain') : t('ci_attachFix')}
      </button>
      <p className="muted small">{note ?? t('ci_fixNote')}</p>
      {problem && (
        <div className="banner err" role="alert">
          {t(problemKey)}
        </div>
      )}
      {error && (
        <div className="banner err" role="alert">
          <ErrorText code={error.code} write uncertain={error.uncertain} />
        </div>
      )}
      <button
        type="button"
        className="primary"
        disabled={locked || locating}
        onClick={() => void send()}
      >
        {t('ci_send')}
      </button>
    </Sheet>
  );
}
