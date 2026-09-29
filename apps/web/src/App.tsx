import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AccountInfo } from '@azure/msal-browser';
import { ApiError, reportApi, type AuthConfig, type Project } from './api.js';
import { EntraAuth, devToken } from './auth.js';
import { I18nProvider, useI18n } from './i18n.js';
import { Icon } from './icons.js';
import { fmtDay, fmtNum, shift, siteToday } from './report/format.js';
import { CheckPage, FillPage, WorkRows } from './report/FillPage.js';
import { liveCoverage, byKind } from './report/model.js';
import { PlanEditor, planListeners } from './report/PlanEditor.js';
import { PlanSession } from './report/plan-session.js';
import { ReportView } from './report/ReportView.js';
import { CorrectionSheet, MenuSheet, NoWorkSheet } from './report/Sheets.js';
import { ActionAborted, useDay } from './report/useDay.js';
import { useIssues } from './report/useIssues.js';
import { FillIssues, ReplySheet } from './report/Issues.js';
import { Sheet } from './ui.js';

type Session = { token: () => Promise<string>; signOut: (() => void) | null };

function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [needLogin, setNeedLogin] = useState<EntraAuth | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const dev = devToken();
    if (dev) {
      setSession({ token: async () => dev, signOut: null });
      return;
    }
    (async () => {
      const config = (await (
        await fetch('/api/auth-config', { cache: 'no-store' })
      ).json()) as AuthConfig;
      const auth = await EntraAuth.create(config);
      const account = auth.current();
      if (account) setSession(fromAccount(auth, account));
      else setNeedLogin(auth);
    })().catch(() => setError('AUTH_NOT_CONFIGURED'));
  }, []);
  const fromAccount = (auth: EntraAuth, account: AccountInfo): Session => ({
    token: () => auth.token(account),
    signOut: () =>
      void auth.signOut(account).then(() => window.location.reload()),
  });
  const signIn = async () => {
    if (!needLogin) return;
    try {
      setSession(fromAccount(needLogin, await needLogin.signIn()));
      setNeedLogin(null);
    } catch {
      setError('LOGIN_FAILED');
    }
  };
  return { session, needLogin: Boolean(needLogin), signIn, error };
}

function Toast({ text }: { text: string | null }) {
  return (
    <div
      id="toast"
      className={text ? 'show' : ''}
      role="status"
      aria-live="polite"
    >
      {text}
    </div>
  );
}

function Workspace({
  session,
  project,
}: {
  session: Session;
  project: Project;
}) {
  const { t, label, locale } = useI18n();
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);
  // The client lives as long as the session; a language change must not reload the day.
  const retryText = useRef(t('retrying'));
  retryText.current = t('retrying');
  const api = useMemo(
    () => reportApi(session.token, () => say(retryText.current)),
    [session, say],
  );
  const [date, setDate] = useState(() => siteToday(project.timezone));
  const [view, setView] = useState<'field' | 'report'>('report');
  const [fieldTab, setFieldTab] = useState<'today' | 'plan'>('today');
  const [task, setTask] = useState<null | 'fill' | 'check'>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [sheet, setSheet] = useState<
    null | 'menu' | 'noWork' | 'correct' | 'issues'
  >(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [actionBusy, setBusy] = useState(false);
  // One PlanSession per target date for the life of the workspace (pending saves survive).
  const plans = useRef(new Map<string, PlanSession>());
  const planFor = (target: string) => {
    let session = plans.current.get(target);
    if (!session) {
      const created: PlanSession = new PlanSession(
        api,
        project.id,
        target,
        () => planListeners(created).forEach((fn) => fn()),
      );
      session = created;
      plans.current.set(target, session);
    }
    return session;
  };
  const h = useDay(api, project.id, date, () => say(t('conflictReloaded')));
  const reloadDay = useCallback(() => void h.reload(), [h.reload]);
  const issues = useIssues(
    api,
    project.id,
    date,
    reloadDay,
    `${h.day?.state ?? ''}:${h.day?.currentRevisionNumber ?? ''}`,
  );
  const busy = actionBusy || h.busy;
  const canWrite = project.access === 'write';
  const wide = useMedia('(min-width: 1100px)');
  useEffect(() => setTask(null), [date]);
  useEffect(() => {
    document.body.classList.toggle('in-task', task !== null);
  }, [task]);

  const day = h.day;
  const liveContent = day && h.facts ? { ...day, facts: h.facts } : null;
  const cov = liveContent ? liveCoverage(liveContent) : null;
  const tomorrowText = day
    ? day.nextPlan.status === 'none'
      ? t('notPlanned')
      : day.nextPlan.rows
          .filter((r) => r.target !== '')
          .map((r) => {
            const it = byKind(day.items, 'work').find((i) => i.key === r.item);
            return `${it ? label(it.label) : r.item} ${fmtNum(r.target, locale)}`;
          })
          .join(' · ') || t('notPlanned')
    : '';

  const run = async (fn: () => Promise<void>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) say(done);
      return true;
    } catch (e) {
      // A conflict has already reloaded the day and told the user.
      if (e instanceof ActionAborted && e.outcome === 'conflict') return false;
      const code =
        e instanceof ActionAborted
          ? e.outcome === 'invalid'
            ? 'NUMBER_INVALID'
            : 'REQUEST_FAILED'
          : e instanceof ApiError
            ? e.code
            : 'REQUEST_FAILED';
      if (code === 'VERSION_CONFLICT' || code === 'LOCKED') return false;
      say(
        code === 'NUMBER_INVALID'
          ? t('numberInvalid')
          : code === 'FORBIDDEN' || code === 'READ_ONLY'
            ? t('forbidden')
            : t('saveFail'),
      );
      return false;
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    const correcting = day?.state === 'correcting';
    if (
      await run(
        h.submit,
        correcting ? t('correctedToast') : t('submittedToast'),
      )
    ) {
      setTask(null);
      setView('report');
    }
  };
  const goFill = (id: string) => {
    setFocus(id);
    setTask('fill');
  };

  const nav = (
    <nav
      className="tabs"
      aria-label={t('mainNav')}
      style={{
        gridTemplateColumns: task ? undefined : 'repeat(2, minmax(0, 1fr))',
      }}
    >
      {(['field', 'report'] as const).map((v) => (
        <button
          key={v}
          type="button"
          className={view === v && !task ? 'on' : ''}
          aria-current={view === v && !task ? 'page' : undefined}
          onClick={() => {
            void h.flush();
            setTask(null);
            setView(v);
          }}
        >
          {v === 'field' ? <Icon.field /> : <Icon.report />}
          <span>{v === 'field' ? t('nav_field') : t('nav_report')}</span>
        </button>
      ))}
    </nav>
  );

  // Issues have their own lifecycle: on a submitted day they are still managed live (and the
  // lag reminder only exists once the day is submitted), while the report stays frozen.
  const manageIssues =
    view === 'report' && !task && canWrite && day?.state === 'submitted' ? (
      <button
        type="button"
        className="card rowbtn"
        onClick={() => {
          void issues.reload();
          setSheet('issues');
        }}
      >
        <span className="grow">
          <b>{t('manageIssues')}</b>
          {issues.lag.length > 0 && (
            <span className="muted small">
              {t('lagTitle', {
                item: issues.lag
                  .map((k) => {
                    const it = day.items.find(
                      (i) => i.kind === 'work' && i.key === k,
                    );
                    return it ? label(it.label) : k;
                  })
                  .join(' · '),
              })}
            </span>
          )}
        </span>
        <Icon.right />
      </button>
    ) : null;
  let body;
  if (h.error)
    body = (
      <div className="banner err">
        {h.error === 'FORBIDDEN' ? t('forbidden') : t('saveFail')}
      </div>
    );
  else if (!day || !h.facts || !h.read || !cov)
    body = <p className="muted">{t('loading')}</p>;
  else if (view === 'report')
    body = (
      <ReportView
        day={day}
        read={h.read}
        canWrite={canWrite}
        missing={cov.missing.length}
        onFill={() => setTask('fill')}
        onNoWork={() => setSheet('noWork')}
        onReply={canWrite ? null : (id) => setReplyTo(id)}
      />
    );
  else {
    const locked = day.state === 'submitted' || !canWrite || busy;
    const today = (
      <section className="card">
        {day.state === 'submitted' && (
          <div className="status-row">
            <span className="chip ok">{t('submittedLocked')}</span>
          </div>
        )}
        <h2 className="blk">{t('doingToday')}</h2>
        <WorkRows h={h} day={day} locked={locked} compact />
      </section>
    );
    const target = shift(date, 1);
    const plan = (
      <PlanEditor
        key={target}
        session={planFor(target)}
        day={day}
        canWrite={canWrite}
        onChanged={() => void h.reload()}
      />
    );
    body = wide ? (
      <div className="fieldwide">
        <div className="pane">{today}</div>
        <div className="pane">
          <h2 className="sec">{t('planTab')}</h2>
          {plan}
        </div>
      </div>
    ) : (
      <>
        <div className="seg" role="tablist">
          {(['today', 'plan'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={fieldTab === k}
              className={fieldTab === k ? 'on' : ''}
              onClick={() => setFieldTab(k)}
            >
              {k === 'today' ? t('todayTab') : t('planTab')}
            </button>
          ))}
        </div>
        {fieldTab === 'plan' ? plan : today}
      </>
    );
  }

  if (task && day && h.facts && cov)
    return (
      <>
        {nav}
        <div className="content">
          {task === 'fill' ? (
            <FillPage
              h={h}
              day={day}
              cov={cov}
              focus={focus}
              onFocused={() => setFocus(null)}
              onBack={() => {
                void h.flush();
                setTask(null);
              }}
              onCheck={() => {
                void h.flush();
                setTask('check');
              }}
              onPlan={() => {
                void h.flush();
                setTask(null);
                setView('field');
                setFieldTab('plan');
              }}
              onSubmit={() => void submit()}
              busy={busy}
              tomorrowText={tomorrowText}
              issues={issues}
              canWrite={canWrite}
            />
          ) : (
            <CheckPage
              h={h}
              day={day}
              cov={cov}
              busy={busy}
              onBack={() => setTask('fill')}
              onFocus={goFill}
              onSubmit={() => void submit()}
            />
          )}
        </div>
        <Toast text={toast} />
      </>
    );

  return (
    <>
      {nav}
      <div className="content">
        <header className="bar">
          <div className="bar-title">
            <span className="bar-sub">
              {project.name}
              {!canWrite && ` · ${t('readOnly')}`}
            </span>
            <label className="bar-date">
              <span>{fmtDay(date, locale)}</span>
              <input
                type="date"
                value={date}
                aria-label={t('date')}
                onChange={(e) => e.target.value && setDate(e.target.value)}
              />
            </label>
          </div>
          <button
            type="button"
            className="icon"
            aria-label={t('prevDay')}
            onClick={() => setDate(shift(date, -1))}
          >
            <Icon.left />
          </button>
          <button
            type="button"
            className="icon"
            aria-label={t('nextDay')}
            onClick={() => setDate(shift(date, 1))}
          >
            <Icon.right />
          </button>
          <button
            type="button"
            className="icon"
            aria-label={t('more')}
            onClick={() => setSheet('menu')}
          >
            <Icon.more />
          </button>
        </header>
        <main className={`page view-${view}`}>
          {body}
          {manageIssues}
        </main>
      </div>
      {sheet === 'menu' && (
        <MenuSheet
          onClose={() => setSheet(null)}
          canCorrect={canWrite && day?.state === 'submitted'}
          canCancel={canWrite && day?.state === 'correcting'}
          revisions={day?.revisions ?? []}
          timeZone={project.timezone}
          onCorrect={() => setSheet('correct')}
          onCancel={() => {
            setSheet(null);
            void run(h.cancelCorrection);
          }}
          onSignOut={session.signOut}
        />
      )}
      {sheet === 'noWork' && (
        <NoWorkSheet
          onClose={() => setSheet(null)}
          onSubmit={async (reason, note) => {
            await run(() => h.noWork(reason, note), t('submittedToast'));
          }}
        />
      )}
      {replyTo && (
        <ReplySheet
          handle={issues}
          issueId={replyTo}
          onClose={() => setReplyTo(null)}
        />
      )}
      {sheet === 'issues' && day && (
        <Sheet title={t('manageIssues')} onClose={() => setSheet(null)}>
          <FillIssues handle={issues} items={day.items} canWrite={canWrite} />
        </Sheet>
      )}
      {sheet === 'correct' && (
        <CorrectionSheet
          onClose={() => setSheet(null)}
          onStart={async (reason) => {
            if (await run(() => h.startCorrection(reason))) setTask('fill');
          }}
        />
      )}
      <Toast text={toast} />
    </>
  );
}

function useMedia(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

function Root() {
  const { t } = useI18n();
  const { session, needLogin, signIn, error } = useSession();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!session) return;
    reportApi(session.token)
      .projects()
      .then((r) => setProjects(r.projects))
      .catch((e) =>
        setFailed(e instanceof ApiError ? e.code : 'REQUEST_FAILED'),
      );
  }, [session]);
  if (error || failed)
    return (
      <main className="page">
        <div className="banner err">
          {failed === 'FORBIDDEN'
            ? t('noProject')
            : error === 'LOGIN_FAILED'
              ? t('signInFailed')
              : t('saveFail')}
        </div>
      </main>
    );
  if (needLogin)
    return (
      <main className="page">
        <button
          type="button"
          className="primary big"
          onClick={() => void signIn()}
        >
          {t('signIn')}
        </button>
      </main>
    );
  if (!session || !projects)
    return <main className="page muted">{t('loading')}</main>;
  const project = projects[0];
  if (!project) return <main className="page">{t('noProject')}</main>;
  return <Workspace session={session} project={project} />;
}

export function App() {
  return (
    <I18nProvider>
      <Root />
    </I18nProvider>
  );
}
