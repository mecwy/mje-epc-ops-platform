import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { AccountInfo } from '@azure/msal-browser';
import { ApiError, reportApi, type AuthConfig, type Project } from './api.js';
import { EntraAuth, devToken } from './auth.js';
import { I18nProvider, useI18n } from './i18n.js';
import { Icon } from './icons.js';
import { fmtDay, fmtNum, shift, siteToday } from './report/format.js';
import { CheckPage, FillPage, WorkRows } from './report/FillPage.js';
import {
  liveCoverage,
  byKind,
  reportPhotos,
  declaredHeadcount,
} from './report/model.js';
import { PlanEditor, planListeners } from './report/PlanEditor.js';
import { PlanSession } from './report/plan-session.js';
import { ReportBody, ReportView } from './report/ReportView.js';
import { historyReducer } from './report/history-view.js';
import { CorrectionSheet, MenuSheet, NoWorkSheet } from './report/Sheets.js';
import { ActionAborted, useDay } from './report/useDay.js';
import { DayRecovery } from './report/DayRecovery.js';
import { useIssues } from './report/useIssues.js';
import { FillIssues, ReplySheet } from './report/Issues.js';
import { usePhotos } from './report/usePhotos.js';
import { PhotoHost, PhotosRow, type PhotoEnv } from './report/Photos.js';
import { SitePage } from './site/SitePage.js';
import { PmOwnerRegistry, pmDayBinding } from './site/pm-owners.js';
import { PmOwnedBar } from './site/OwnedBar.js';
import { useSessions } from './site/use-sessions.js';
import { PmFieldContext, type PmField } from './report/CheckInsBeside.js';
import { Sheet } from './ui.js';
import { ContractsWorkspace } from './contracts/ContractsWorkspace.js';
import { OpportunitiesWorkspace } from './opportunities/OpportunitiesWorkspace.js';
import {
  ResumeKeeper,
  renewal,
  signInFailure,
  type SignInFailure,
} from './signin.js';

type Session = {
  token: () => Promise<string>;
  signOut: (() => void) | null;
  /** Sign in again by full-page redirect once the token cannot be renewed silently. */
  renew: (() => Promise<void>) | null;
};
/** Sign-in state the workspace shows: expiry, a running redirect, the last failure. */
interface SignInState {
  expired: boolean;
  redirecting: boolean;
  failure: SignInFailure | null;
}

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [needLogin, setNeedLogin] = useState<EntraAuth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<SignInFailure | null>(null);
  const [expired, setExpired] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const authRef = useRef<EntraAuth | null>(null);
  useEffect(() => {
    // Back from the Microsoft page may restore this page from the browser cache: allow a retry.
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      authRef.current?.backForwardRestored();
      setRedirecting(false);
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);
  useEffect(() => {
    const dev = devToken();
    if (dev) {
      setSession({ token: async () => dev, signOut: null, renew: null });
      return;
    }
    (async () => {
      const config = (await (
        await fetch('/api/auth-config', { cache: 'no-store' })
      ).json()) as AuthConfig;
      const auth = await EntraAuth.create(config);
      authRef.current = auth;
      if (auth.redirectError) setFailure(signInFailure(auth.redirectError));
      auth.onExpired(() => setExpired(true));
      const account = auth.current();
      if (account) setSession(fromAccount(auth, account));
      else setNeedLogin(auth);
    })().catch(() => setError('AUTH_NOT_CONFIGURED'));
  }, []);
  /** One interaction at a time; a redirect normally leaves the page before it resolves. */
  const interact = async (go: () => Promise<void>) => {
    setFailure(null);
    setRedirecting(true);
    try {
      await go();
    } catch (e) {
      setFailure(signInFailure(e));
    } finally {
      setRedirecting(false);
    }
  };
  const fromAccount = (auth: EntraAuth, account: AccountInfo): Session => ({
    token: () => auth.token(account),
    signOut: () =>
      void auth.signOut(account).then((leaving) => {
        if (!leaving) window.location.reload();
      }),
    renew: () => interact(() => auth.renew(account)),
  });
  const signIn = () =>
    interact(async () => {
      if (!needLogin) return;
      const account = await needLogin.signIn();
      if (!account) return; // leaving for Microsoft
      setSession(fromAccount(needLogin, account));
      setNeedLogin(null);
    });
  const state: SignInState = { expired, redirecting, failure };
  return { session, needLogin: Boolean(needLogin), signIn, error, state };
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
  signin,
  resume,
}: {
  session: Session;
  project: Project;
  signin: SignInState;
  /** What was put aside before a sign-in redirect. */
  resume: ResumeKeeper;
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
  const [place] = useState(() =>
    resume.state?.projectId === project.id ? resume.state : null,
  );
  const [date, setDate] = useState(
    () => place?.date ?? siteToday(project.timezone),
  );
  const canWrite = project.access === 'write';
  // The site page (QR code, devices) is PM-only; a reader never gets it (OD20).
  const [view, setView] = useState<'field' | 'report' | 'site'>(() =>
    place?.view === 'site' && !canWrite ? 'report' : (place?.view ?? 'report'),
  );
  // The place is restored; drafts of other projects cannot be and are dropped.
  useEffect(() => resume.opened(project.id), [resume, project.id]);
  const [fieldTab, setFieldTab] = useState<'today' | 'plan'>('today');
  const [task, setTask] = useState<null | 'fill' | 'check'>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [sheet, setSheet] = useState<
    null | 'menu' | 'noWork' | 'correct' | 'issues'
  >(null);
  const [focus, setFocus] = useState<string | null>(null);
  // A submitted version opened from the history, read-only (see history-view.ts).
  const [viewing, dispatchView] = useReducer(historyReducer, null);
  const viewTicket = useRef(0);
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
  const h = useDay(
    api,
    project.id,
    date,
    () => say(t('conflictReloaded')),
    resume,
  );
  const reloadDay = useCallback(() => void h.reload(), [h.reload]);
  const dayStamp = `${h.day?.state ?? ''}:${h.day?.currentRevisionNumber ?? ''}`;
  const issues = useIssues(api, project.id, date, reloadDay, dayStamp);
  const photos = usePhotos(api, project.id, date, dayStamp);
  const busy = actionBusy || h.busy;
  // The PM command owners (People page sessions and adoption flows) live as long as the
  // workspace, one set per project (AGENTS.md): leaving a tab, losing write access or
  // switching projects and back keeps an unresolved command, its key and its payload.
  const [pmRegistry] = useState(() => new PmOwnerRegistry(api));
  const pm = pmRegistry.get(project.id);
  const siteSessions = pm.site;
  useSessions(siteSessions);
  // Check-ins beside the headcount (writers only; a reader never gets them, OD20).
  useEffect(() => {
    if (canWrite) void siteSessions.checkIns(date).list.load();
  }, [canWrite, siteSessions, date]);
  // The PM's explicit adoption of foreman totals, one flow per day (PmOwners). Its day binding
  // is made once per project against the workspace's day store: every lock and read goes to
  // that project's own day entry, never to whatever day the page shows later.
  pm.day ??= pmDayBinding(h.store, project.id);
  const pmField: PmField | null =
    canWrite && h.day
      ? {
          foreman: h.day.foreman ?? null,
          adopt: pm.adoptFor(date),
          canWrite,
          dayState: h.day.state,
          timeZone: project.timezone,
          checkIns: siteSessions.checkIns(date).list.data?.summary ?? null,
        }
      : null;
  const withPmField = (node: ReactNode) => (
    <PmFieldContext.Provider value={pmField}>{node}</PmFieldContext.Provider>
  );
  const wide = useMedia('(min-width: 1100px)');
  useEffect(() => setTask(null), [date]);
  // Another day, or starting a task, closes the version being viewed.
  useEffect(() => dispatchView({ type: 'close' }), [date]);
  useEffect(() => {
    if (task !== null) dispatchView({ type: 'close' });
  }, [task]);
  const openVersion = (n: number) => {
    const ticket = ++viewTicket.current;
    setSheet(null);
    // Versions are shown on the report tab, never over the field page or an open task.
    setTask(null);
    setView('report');
    dispatchView({ type: 'open', n, ticket });
    api.revision(project.id, date, n).then(
      (rev) => dispatchView({ type: 'loaded', ticket, rev }),
      () => dispatchView({ type: 'failed', ticket }),
    );
  };
  useEffect(() => {
    document.body.classList.toggle('in-task', task !== null);
  }, [task]);

  const day = h.day;
  const liveContent = day && h.facts ? { ...day, facts: h.facts } : null;
  const cov = liveContent
    ? liveCoverage(liveContent, photos.session.photographed())
    : null;
  const photoEnv: PhotoEnv = {
    handle: photos,
    items: day ? byKind(day.items, 'work') : [],
    issues: (issues.issues ?? []).map((i) => ({
      id: i.id,
      title: i.title,
      status: i.status,
    })),
    canWrite,
    // Uploads follow the day lock; links may change on any day (rule 1).
    canUpload: canWrite && day !== null && day.state !== 'submitted' && !busy,
    timeZone: project.timezone,
  };
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
      // Another command holds the day's lock (an adoption, say): nothing was sent.
      if (e instanceof ActionAborted && e.outcome === 'busy') {
        say(t('dayBusy'));
        return false;
      }
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
  // Before leaving for Microsoft: try to send pending edits (bounded; without a token they
  // cannot land), then put aside what is unsaved or not yet restored, plus the place.
  const steps = useRef<Parameters<typeof renewal>[0]>({
    flush: h.flush,
    snapshot: () => false,
    redirect: async () => {},
  });
  steps.current = {
    flush: h.flush,
    snapshot: () => {
      const unsaved = h.unsaved();
      const kept = resume.save(
        { projectId: project.id, date, view },
        unsaved,
        Date.now(),
      );
      return kept || (unsaved.length === 0 && resume.pendingCount === 0);
    },
    redirect: async () => {
      await session.renew?.();
    },
  };
  const [renewer] = useState(() =>
    renewal({
      flush: () => steps.current.flush(),
      snapshot: () => steps.current.snapshot(),
      redirect: () => steps.current.redirect(),
    }),
  );
  const [renewBusy, setRenewBusy] = useState(false);
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      renewer.reset();
      setRenewBusy(false);
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, [renewer]);
  const renew = async () => {
    setRenewBusy(true);
    const outcome = await renewer.start();
    if (outcome === 'busy') return;
    setRenewBusy(false);
    if (outcome === 'unsaved') say(t('saveFail'));
  };
  const goFill = (id: string) => {
    setFocus(id);
    setTask('fill');
  };

  const views = canWrite
    ? (['field', 'report', 'site'] as const)
    : (['field', 'report'] as const);
  const navIcon = { field: Icon.field, report: Icon.report, site: Icon.site };
  const navLabel = {
    field: t('nav_field'),
    report: t('nav_report'),
    site: t('nav_people'),
  };
  const nav = (
    <nav
      className="tabs"
      aria-label={t('mainNav')}
      // The column count applies to the phone's bottom bar only; wider screens use a sidebar.
      style={
        task ? undefined : ({ '--tabs': views.length + 1 } as CSSProperties)
      }
    >
      {views.map((v) => {
        const NavIcon = navIcon[v];
        return (
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
            <NavIcon />
            <span>{navLabel[v]}</span>
          </button>
        );
      })}
      <button
        type="button"
        onClick={() =>
          void h.flush().then((outcome) => {
            if (outcome === 'ok') window.location.assign('/contracts');
          })
        }
      >
        <Icon.report />
        <span>{t('ctTitle')}</span>
      </button>
    </nav>
  );

  // Issues have their own lifecycle: on a submitted day they are still managed live (and the
  // lag reminder only exists once the day is submitted), while the report stays frozen.
  // Correction is found where the submitted report is read, not only in the "more" menu.
  const correctEntry =
    view === 'report' &&
    !task &&
    !viewing &&
    canWrite &&
    day?.state === 'submitted' ? (
      <button
        type="button"
        className="card rowbtn"
        onClick={() => setSheet('correct')}
      >
        <span className="grow">
          <b>{t('startCorrect')}</b>
        </span>
        <Icon.right />
      </button>
    ) : null;
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
  if (view === 'site' && canWrite && !task)
    body = (
      <SitePage
        api={api}
        project={project}
        sessions={siteSessions}
        date={date}
        headcount={h.facts ? declaredHeadcount(h.facts) : null}
      />
    );
  else if (viewing && view === 'report' && !task) {
    const meta = day?.revisions.find((r) => r.n === viewing.n) ?? null;
    body = (
      <>
        <div className="banner warn">
          {viewing.n === day?.currentRevisionNumber
            ? t('viewingCurrentVersion', { n: viewing.n })
            : t('viewingVersion', { n: viewing.n })}{' '}
          <button
            type="button"
            className="pill"
            onClick={() => dispatchView({ type: 'close' })}
          >
            {t('backToCurrent')}
          </button>
        </div>
        {viewing.failed ? (
          <div className="banner err">{t('loadFail')}</div>
        ) : viewing.rev ? (
          <ReportBody
            c={viewing.rev.snapshot}
            version={meta ?? viewing.rev}
            timeZone={project.timezone}
            photos={viewing.rev.snapshot.photos ?? []}
          />
        ) : (
          <p className="muted">{t('loading')}</p>
        )}
      </>
    );
  } else if (h.error && !h.stale)
    // A locked day's failed read is explained by DayRecovery (worded by what the command did),
    // with the last facts read-only below it; "Save failed" would contradict "not known".
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
        photos={reportPhotos(day.state, h.read, photos.photos)}
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
    return withPmField(
      <PhotoHost env={photoEnv}>
        {nav}
        <div className="content">
          {/* The Fill and Check views too: a locked day's recovery is never hidden. */}
          <DayRecovery h={h} />
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
              photos={photos}
            />
          )}
        </div>
        <Toast text={toast} />
      </PhotoHost>,
    );

  // The current photos, to link them; the report itself shows what the day froze.
  const photosRow =
    view === 'report' &&
    !task &&
    canWrite &&
    day &&
    (day.state !== 'empty' || (photos.photos?.length ?? 0) > 0) ? (
      <PhotosRow />
    ) : null;
  return withPmField(
    <PhotoHost env={photoEnv}>
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
          <DayRecovery h={h} />
          {!canWrite && (
            // Write access went away while a PM attempt was owned: its Retry / Give up stay.
            <PmOwnedBar
              owners={pm}
              itemLabel={(k) => {
                const it = day?.items.find((i) => i.key === k);
                return it ? label(it.label) : k;
              }}
            />
          )}
          {signin.expired && (
            <div className="banner err" role="alert">
              {signin.failure ? (
                <FailureText failure={signin.failure} />
              ) : (
                t('signInExpired')
              )}{' '}
              <button
                type="button"
                disabled={signin.redirecting || renewBusy}
                onClick={() => void renew()}
              >
                {t('signInAgain')}
              </button>
            </div>
          )}
          {body}
          {correctEntry}
          {photosRow && !viewing ? photosRow : null}
          {manageIssues && !viewing ? manageIssues : null}
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
          onView={openVersion}
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
    </PhotoHost>,
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

function FailureText({ failure }: { failure: SignInFailure }) {
  const { t } = useI18n();
  return (
    <>
      {t(failure.key)}
      {failure.code && ` (${failure.code})`}
    </>
  );
}

function Root() {
  const { t } = useI18n();
  const { session, needLogin, signIn, error, state } = useSession();
  const [resume] = useState(() => new ResumeKeeper(sessionStore(), Date.now()));
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (
      !session ||
      ['/contracts', '/opportunities'].includes(window.location.pathname)
    )
      return;
    reportApi(session.token)
      .projects()
      .then((r) => setProjects(r.projects))
      .catch((e) =>
        setFailed(e instanceof ApiError ? e.code : 'REQUEST_FAILED'),
      );
  }, [session]);
  // Signed out, or expired before the workspace opened: the sign-in screen, never a dead end.
  const renewing = Boolean(session?.renew && state.expired && !projects);
  if (needLogin || renewing)
    return (
      <main className="page">
        {(state.failure || renewing) && (
          <div className="banner err" role="alert">
            {state.failure ? (
              <FailureText failure={state.failure} />
            ) : (
              t('signInExpired')
            )}
          </div>
        )}
        <button
          type="button"
          className="primary big"
          disabled={state.redirecting}
          onClick={() => void (renewing ? session?.renew?.() : signIn())}
        >
          {t('signIn')}
        </button>
      </main>
    );
  if (session && window.location.pathname === '/opportunities')
    return (
      <OpportunitiesWorkspace
        token={session.token}
        signOut={session.signOut}
        renew={session.renew}
        expired={state.expired}
      />
    );
  if (session && window.location.pathname === '/contracts')
    return (
      <ContractsWorkspace
        token={session.token}
        signOut={session.signOut}
        renew={session.renew}
        expired={state.expired}
      />
    );
  if (error || failed)
    return (
      <main className="page">
        <div className="banner err">
          {failed === 'FORBIDDEN' ? t('noProject') : t('saveFail')}
        </div>
        {session && (
          <>
            <a href="/contracts">{t('ctTitle')}</a>
            <a href="/opportunities">{t('opTitle')}</a>
          </>
        )}
      </main>
    );
  if (!session || !projects)
    return <main className="page muted">{t('loading')}</main>;
  const project =
    projects.find((p) => p.id === resume.state?.projectId) ?? projects[0];
  if (!project)
    return (
      <main className="page">
        <p>{t('noProject')}</p>
        <a href="/contracts">{t('ctTitle')}</a>
      </main>
    );
  return (
    <Workspace
      session={session}
      project={project}
      signin={state}
      resume={resume}
    />
  );
}

export function App() {
  return (
    <I18nProvider>
      <Root />
    </I18nProvider>
  );
}
