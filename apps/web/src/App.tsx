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
import { dayCommandNotice } from './report/FillPage.js';
import {
  liveCoverage,
  byKind,
  reportPhotos,
  declaredHeadcount,
} from './report/model.js';
import { PlanEditor, planListeners } from './report/PlanEditor.js';
import { PlanSession } from './report/plan-session.js';
import { PersonnelMetricsSession } from './report/personnel-metrics-session.js';
import {
  WeatherLocation,
  FrozenWeatherReferences,
} from './report/WeatherLocation.js';
import {
  WeatherLocationSession,
  type WeatherContext,
} from './report/weather-location-session.js';
import {
  disabledWeatherPorts,
  type WeatherPresentationPorts,
} from './report/weather-adapter.js';
import { parseReportLocationCandidate } from '@mje/contracts';
import { createBrowserWeatherPorts } from './report/browser-weather-ports.js';
import type { PersonnelRevisionLink } from './report/PersonnelMetrics.js';
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
import { ExecutiveHome } from './executive/ExecutiveHome.js';
import { ProjectStatusSession } from './executive/status-session.js';
import { ProjectOverview } from './executive/ProjectOverview.js';
import { AttentionInbox } from './executive/AttentionInbox.js';
import { ProjectIssueEntry } from './executive/ProjectIssueEntry.js';
import { ProjectOverviewSession } from './executive/overview-session.js';
import {
  executiveHref,
  parseExecutiveRoute,
  parseReportRoute,
  reportHref,
} from './executive/overview-routing.js';
import { PmOwnerRegistry, pmDayBinding } from './site/pm-owners.js';
import { PmOwnedBar } from './site/OwnedBar.js';
import { useSessions } from './site/use-sessions.js';
import { PmFieldContext, type PmField } from './report/CheckInsBeside.js';
import { Sheet } from './ui.js';
import { ContractsWorkspace } from './contracts/ContractsWorkspace.js';
import { OpportunitiesWorkspace } from './opportunities/OpportunitiesWorkspace.js';
import { WorkspaceShell } from './workspace/WorkspaceShell.js';
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

type WorkspaceDrafts = Pick<ReturnType<typeof useDay>, 'flush' | 'unsaved'>;

/** One sign-in snapshot covers every mounted authorised workspace, not just the visible one. */
export function workspaceRecovery(workspaces: Map<string, WorkspaceDrafts>) {
  return {
    flush: () => Promise.all([...workspaces.values()].map((w) => w.flush())),
    unsaved: () => [...workspaces.values()].flatMap((w) => w.unsaved()),
  };
}

function Workspace({
  session,
  project,
  signin,
  resume,
  recoveryWorkspaces,
  pmRegistry,
  onExecutiveHome,
  requestedDate,
  onDateChange,
  active,
  weatherPorts,
  forecastEnabled = false,
}: {
  session: Session;
  project: Project;
  signin: SignInState;
  onExecutiveHome: () => void;
  active: boolean;
  requestedDate?: string;
  onDateChange: (date: string) => void;
  /** What was put aside before a sign-in redirect. */
  resume: ResumeKeeper;
  recoveryWorkspaces: Map<string, WorkspaceDrafts>;
  pmRegistry: PmOwnerRegistry;
  weatherPorts?: WeatherPresentationPorts;
  forecastEnabled?: boolean;
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
  const forecastPorts = useMemo(
    () => (forecastEnabled ? createBrowserWeatherPorts(api) : null),
    [api, forecastEnabled],
  );
  const [weatherVisible, setWeatherVisible] = useState(() => !document.hidden);
  const weatherRenewing = useRef(false);
  const [renewBusy, setRenewBusy] = useState(false);
  const [place] = useState(() =>
    resume.state?.projectId === project.id ? resume.state : null,
  );
  const [date, setDateValue] = useState(
    () => requestedDate ?? place?.date ?? siteToday(project.timezone),
  );
  useEffect(() => {
    if (requestedDate) setDateValue(requestedDate);
  }, [requestedDate]);
  const setDate = (next: string) => {
    setDateValue(next);
    onDateChange(next);
  };
  const canWrite = project.access === 'write';
  // The site page (QR code, devices) is PM-only; a reader never gets it (OD20).
  const [view, setView] = useState<'field' | 'report' | 'site'>(() =>
    place?.view === 'site' && !canWrite ? 'report' : (place?.view ?? 'report'),
  );
  // Each authorised project retains its own recovery entries across workspace mounts.
  useEffect(() => resume.opened(), [resume, project.id]);
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
  const weatherSessions = useMemo(
    () => new Map<string, WeatherLocationSession>(),
    [api, project.id],
  );
  const weatherOwner = useMemo(() => crypto.randomUUID(), [api]);
  const weatherAccess = useRef({
    date,
    canWrite,
    active,
    expired: signin.expired,
  });
  weatherAccess.current = { date, canWrite, active, expired: signin.expired };
  const weatherEntry = h.store.entry(project.id, date);
  let weatherSession = weatherSessions.get(date);
  if (!weatherSession) {
    const scope = {
      ownerKey: weatherOwner,
      projectId: project.id,
      businessDate: date,
      timezone: project.timezone,
      locationVersionId: weatherPorts?.locationVersionId ?? null,
    };
    const accepts = (context: Readonly<WeatherContext>) => {
      const current = weatherSessions.get(scope.businessDate)?.getSnapshot();
      return (
        !!current &&
        current.writable &&
        !current.locked &&
        !document.hidden &&
        !weatherRenewing.current &&
        weatherAccess.current.date === scope.businessDate &&
        weatherAccess.current.canWrite &&
        weatherAccess.current.active &&
        !weatherAccess.current.expired &&
        context.ownerKey === scope.ownerKey &&
        context.projectId === scope.projectId &&
        context.businessDate === scope.businessDate &&
        context.timezone === scope.timezone &&
        context.locationVersionId === current.context.locationVersionId
      );
    };
    weatherSession = new WeatherLocationSession(
      scope,
      {
        ...(forecastPorts ?? {}),
        loadWeather:
          weatherPorts?.loadWeather ??
          forecastPorts?.loadWeather ??
          disabledWeatherPorts.loadWeather,
        locate: weatherPorts?.locate ?? disabledWeatherPorts.locate,
        acceptLocation: parseReportLocationCandidate,
        confirmLocation: (context, candidate) =>
          accepts(context) &&
          h.store.editWeather(weatherEntry, weatherEntry.session.facts, {
            kind: 'capture',
            candidate,
            clientConfirmedAt: new Date().toISOString(),
          }),
        referenceWeather: (context, snapshotId) =>
          !!context.locationVersionId &&
          accepts(context) &&
          !(weatherEntry.session.facts.weatherReferences ?? []).some(
            (ref) =>
              ref.locationVersionId === context.locationVersionId &&
              ref.snapshotId === snapshotId,
          ) &&
          h.store.editWeather(weatherEntry, {
            ...weatherEntry.session.facts,
            weatherReferences: [
              ...(weatherEntry.session.facts.weatherReferences ?? []),
              { locationVersionId: context.locationVersionId, snapshotId },
            ],
          }),
      },
      { writable: canWrite, locked: true },
    );
    weatherSessions.set(date, weatherSession);
  }
  useEffect(() => {
    weatherSession.setAccess({
      writable:
        canWrite &&
        !signin.expired &&
        active &&
        weatherVisible &&
        !renewBusy &&
        !weatherRenewing.current,
      locked: h.busy || !h.day || h.day.state === 'submitted',
    });
    if (!weatherEntry.session.weatherNeedsSave)
      weatherSession.acknowledgeSavedIntent();
  }, [
    weatherSession,
    weatherEntry,
    canWrite,
    signin.expired,
    active,
    weatherVisible,
    renewBusy,
    h.busy,
    h.day?.state,
    h.day?.version,
  ]);
  useEffect(() => {
    const visibility = () => {
      if (document.hidden)
        for (const item of weatherSessions.values())
          item.setAccess({ writable: false, locked: true });
      setWeatherVisible(!document.hidden);
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      for (const item of weatherSessions.values()) item.deactivate();
    };
  }, [weatherSessions]);
  const personnelWindows = useMemo(
    () => new Map<string, PersonnelMetricsSession>(),
    [api, project.id],
  );
  let personnelSession = personnelWindows.get(date);
  if (!personnelSession) {
    personnelSession = new PersonnelMetricsSession(api, project.id, date);
    personnelWindows.set(date, personnelSession);
  }
  useEffect(() => {
    void personnelSession.refresh();
  }, [
    personnelSession,
    h.day?.state,
    h.day?.currentRevisionNumber,
    signin.expired,
    active,
    canWrite,
  ]);
  const pendingPersonnelRevision = useRef<PersonnelRevisionLink | null>(null);
  const latestDrafts = useRef(h);
  latestDrafts.current = h;
  useEffect(() => {
    if (!canWrite) return;
    const entry: WorkspaceDrafts = {
      flush: () => latestDrafts.current.flush(),
      unsaved: () => latestDrafts.current.unsaved(),
    };
    recoveryWorkspaces.set(project.id, entry);
    return () => {
      if (recoveryWorkspaces.get(project.id) === entry)
        recoveryWorkspaces.delete(project.id);
    };
  }, [recoveryWorkspaces, project.id, canWrite]);
  const reloadDay = useCallback(() => void h.reload(), [h.reload]);
  const dayStamp = `${h.day?.state ?? ''}:${h.day?.currentRevisionNumber ?? ''}`;
  const issues = useIssues(api, project.id, date, reloadDay, dayStamp);
  const photos = usePhotos(api, project.id, date, dayStamp);
  const busy = actionBusy || h.busy;
  // The PM command owners (People page sessions and adoption flows) live as long as the
  // workspace, one set per project (AGENTS.md): leaving a tab, losing write access or
  // switching projects and back keeps an unresolved command, its key and its payload.
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
  pm.adoptFor(date).workspaceRecovery = true;
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
  useEffect(() => {
    dispatchView({ type: 'close' });
    const target = pendingPersonnelRevision.current;
    if (target?.businessDate === date && target.projectId === project.id) {
      pendingPersonnelRevision.current = null;
      openVersion(target.n, target.reportRevisionId);
    }
  }, [date]);
  useEffect(() => {
    if (task !== null) dispatchView({ type: 'close' });
  }, [task]);
  const openVersion = (n: number, reportRevisionId?: string) => {
    const ticket = ++viewTicket.current;
    setSheet(null);
    // Versions are shown on the report tab, never over the field page or an open task.
    setTask(null);
    setView('report');
    dispatchView({ type: 'open', n, ticket });
    api.revision(project.id, date, n).then(
      (rev) =>
        dispatchView(
          reportRevisionId && rev.reportRevisionId !== reportRevisionId
            ? { type: 'failed', ticket }
            : { type: 'loaded', ticket, rev },
        ),
      () => dispatchView({ type: 'failed', ticket }),
    );
  };

  const openPersonnelRevision = (target: PersonnelRevisionLink) => {
    if (target.projectId !== project.id) return;
    if (target.businessDate === date)
      openVersion(target.n, target.reportRevisionId);
    else {
      pendingPersonnelRevision.current = target;
      setDate(target.businessDate);
    }
  };

  useEffect(() => {
    // A command reply may be lost even when the fresh read confirms a submitted day.
    // Leave its editing/check screen based on that read, without claiming our send succeeded.
    if (h.day?.state === 'submitted' && task !== null) {
      setTask(null);
      setView('report');
    }
  }, [h.day?.state, task]);

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
      const notice = dayCommandNotice(
        code,
        e instanceof ApiError && e.afterLostAttempt,
      );
      say(t(notice));
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
  const workspaceDrafts = workspaceRecovery(recoveryWorkspaces);
  steps.current = {
    flush: workspaceDrafts.flush,
    snapshot: () => {
      const unsaved = workspaceDrafts.unsaved();
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
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      renewer.reset();
      weatherRenewing.current = false;
      setRenewBusy(false);
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, [renewer]);
  const renew = async () => {
    weatherRenewing.current = true;
    for (const item of weatherSessions.values())
      item.setAccess({ writable: false, locked: true });
    setRenewBusy(true);
    const outcome = await renewer.start();
    if (outcome === 'busy') return;
    weatherRenewing.current = false;
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
        className="portfolio-nav"
        onClick={() => {
          void h.flush();
          setTask(null);
          onExecutiveHome();
        }}
      >
        <Icon.home />
        <span>{t('nav_home')}</span>
      </button>
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
            onOpenPersonnelRevision={openPersonnelRevision}
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
        personnelSession={personnelSession}
        onOpenPersonnelRevision={openPersonnelRevision}
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

  // Keep command owners and day sessions alive, but mount only the active form tree.
  // Hidden forms would duplicate input IDs and redirect labels/focus to another project.
  if (!active) return null;

  if (task && day && h.facts && cov)
    return withPmField(
      <PhotoHost env={photoEnv}>
        <WorkspaceShell
          navigation={nav}
          header={null}
          view={view}
          containsMain
          entry
        >
          {/* The Fill and Check views too: a locked day's recovery is never hidden. */}
          <DayRecovery
            h={{ ...h, stale: h.stale && !pm.adoptFor(date).settling }}
          />
          {task === 'fill' ? (
            <>
              <FrozenWeatherReferences
                references={h.read?.weatherReferences ?? []}
              />
              <FillPage
                weatherControlsVisible={forecastEnabled}
                weatherControlsPending={weatherEntry.session.weatherNeedsSave}
                weatherControls={
                  (((forecastEnabled || weatherPorts !== undefined) &&
                    canWrite) ||
                    weatherEntry.session.weatherNeedsSave) && (
                    <WeatherLocation
                      session={weatherSession}
                      weatherEnabled={
                        forecastEnabled ||
                        (!!weatherPorts?.loadWeather &&
                          !!weatherPorts?.locationVersionId)
                      }
                      locationEnabled={weatherPorts !== undefined}
                      savedSnapshotIds={
                        h.facts.weatherReferences?.map(
                          (ref) => ref.snapshotId,
                        ) ?? []
                      }
                      savedLocation={h.facts.reportLocationRef ?? null}
                      pendingLocationKind={
                        weatherEntry.session.pendingLocationKind
                      }
                      pendingSave={weatherEntry.session.weatherUnknown}
                      onRetrySave={() => void h.flush()}
                      onClearLocation={() => {
                        h.store.editWeather(
                          weatherEntry,
                          weatherEntry.session.facts,
                          { kind: 'clear' },
                        );
                      }}
                      {...(h.facts.weatherReferences?.length
                        ? {
                            onDetachWeather: () => {
                              h.store.editWeather(weatherEntry, {
                                ...weatherEntry.session.facts,
                                weatherReferences: [],
                              });
                            },
                          }
                        : {})}
                    />
                  )
                }
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
            </>
          ) : (
            <CheckPage
              projectName={project.name}
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
        </WorkspaceShell>
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
      <WorkspaceShell
        containsMain={task !== null}
        navigation={nav}
        view={view}
        header={
          <>
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
          </>
        }
      >
        <DayRecovery
          h={{ ...h, stale: h.stale && !pm.adoptFor(date).settling }}
        />
        {!canWrite && (
          // Write access went away while a PM attempt was owned: its Retry / Give up stay.
          <PmOwnedBar
            owners={pm}
            includeAdoptions={false}
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
      </WorkspaceShell>
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
          onSignOut={
            session.signOut
              ? () => {
                  weatherRenewing.current = true;
                  for (const item of weatherSessions.values())
                    item.setAccess({ writable: false, locked: true });
                  session.signOut?.();
                }
              : null
          }
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

function Root({
  weatherPorts,
  forecastEnabled = false,
}: {
  weatherPorts?: WeatherPresentationPorts;
  forecastEnabled?: boolean;
}) {
  const { t } = useI18n();
  const { session, needLogin, signIn, error, state } = useSession();
  const [resume] = useState(() => new ResumeKeeper(sessionStore(), Date.now()));
  const recoveryWorkspaces = useMemo(
    () => new Map<string, WorkspaceDrafts>(),
    [session],
  );
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [hash, setHash] = useState(() => window.location.hash);
  const route = parseExecutiveRoute(hash);
  const reportRoute = parseReportRoute(hash);
  const [visited, setVisited] = useState<string[]>([]);
  const reportDates = useRef(new Map<string, string>());
  const [projectsOwner, setProjectsOwner] = useState<Session | null>(null);
  useEffect(() => {
    const changed = () => setHash(window.location.hash);
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  const showExecutiveHome = route?.kind === 'home';
  const openReport = (id?: string, date?: string) => {
    const selected = projects?.find((p) => p.id === (id ?? selectedProjectId));
    if (!selected) return;
    setSelectedProjectId(selected.id);
    const businessDate =
      date ??
      reportDates.current.get(selected.id) ??
      (resume.state?.projectId === selected.id
        ? resume.state.date
        : siteToday(selected.timezone));
    reportDates.current.set(selected.id, businessDate);
    window.location.hash = reportHref({ projectId: selected.id, businessDate });
  };
  const executiveApi = useMemo(
    () => (session ? reportApi(session.token) : null),
    [session],
  );
  // Adopt owners survive project/tab/date switches; one workspace-level recovery surface.
  const pmRegistry = useMemo(
    () => (executiveApi ? new PmOwnerRegistry(executiveApi) : null),
    [executiveApi],
  );
  const [, ownedChanged] = useReducer((n: number) => n + 1, 0);
  useEffect(() => pmRegistry?.subscribe(ownedChanged), [pmRegistry]);
  const statusSessions = useMemo(
    () => new Map<string, ProjectStatusSession>(),
    [session],
  );
  const overviewSessions = useMemo(
    () => new Map<string, ProjectOverviewSession>(),
    [session],
  );
  const getOverviewSession = (projectId: string) => {
    if (!executiveApi) throw new Error('Session missing');
    let store = overviewSessions.get(projectId);
    if (!store) {
      store = new ProjectOverviewSession(executiveApi, projectId);
      overviewSessions.set(projectId, store);
    }
    return store;
  };
  const getStatusSession = useCallback(
    (projectId: string) => {
      if (!executiveApi) throw new Error('Session missing');
      let store = statusSessions.get(projectId);
      if (!store) {
        store = new ProjectStatusSession(executiveApi, projectId);
        statusSessions.set(projectId, store);
      }
      return store;
    },
    [executiveApi, statusSessions],
  );
  useEffect(() => {
    setSelectedProjectId(null);
    setVisited([]);
    reportDates.current.clear();
  }, [session]);
  useEffect(() => {
    let current = true;
    setProjects(null);
    setProjectsOwner(null);
    setFailed(null);
    if (
      session &&
      !['/contracts', '/opportunities'].includes(window.location.pathname)
    )
      void reportApi(session.token)
        .projects()
        .then((r) => {
          if (current) {
            resume.retainWritableProjects(
              r.projects.filter((p) => p.access === 'write').map((p) => p.id),
            );
            setProjects(r.projects);
            setProjectsOwner(session);
          }
        })
        .catch((e) => {
          if (current)
            setFailed(e instanceof ApiError ? e.code : 'REQUEST_FAILED');
        });
    return () => {
      current = false;
    };
  }, [session, resume]);
  useEffect(() => {
    if (selectedProjectId || !projects?.length) return;
    setSelectedProjectId(
      projects.find((p) => p.id === resume.state?.projectId)?.id ??
        projects[0]!.id,
    );
  }, [projects, resume, selectedProjectId]);
  useEffect(() => {
    if (projectsOwner !== session || !projects?.length) return;
    const id = reportRoute?.projectId ?? selectedProjectId;
    if (!id || !projects.some((p) => p.id === id)) return;
    setVisited((previous) =>
      previous.includes(id) ? previous : [...previous, id],
    );
    if (reportRoute) {
      setSelectedProjectId(id);
      reportDates.current.set(id, reportRoute.businessDate);
    }
  }, [
    projects,
    projectsOwner,
    session,
    selectedProjectId,
    reportRoute?.projectId,
    reportRoute?.businessDate,
  ]);
  const ownedBars = pmRegistry
    ?.all()
    .map((owners) => (
      <PmOwnedBar
        key={owners.projectId}
        owners={owners}
        canWrite={
          projects?.some(
            (p) => p.id === owners.projectId && p.access === 'write',
          ) ?? false
        }
        projectLabel={
          projects?.find((p) => p.id === owners.projectId)?.name ??
          owners.projectId
        }
        itemLabel={() => ''}
        adoptionOnly
      />
    ));

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
        {ownedBars}
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
  if (!session || !projects || projectsOwner !== session)
    return (
      <main className="page muted">
        {ownedBars}
        {t('loading')}
      </main>
    );
  const project =
    projects.find(
      (p) => p.id === (reportRoute?.projectId ?? selectedProjectId),
    ) ?? projects[0];
  if (!project)
    return (
      <main className="page">
        {ownedBars}
        <p>{t('noProject')}</p>
        <a href="/contracts">{t('ctTitle')}</a>
        <a href="/opportunities">{t('opTitle')}</a>
      </main>
    );
  const routedProject =
    route && 'projectId' in route
      ? projects.find((p) => p.id === route.projectId)
      : null;
  const unavailableRoute = route && 'projectId' in route && !routedProject;
  const invalidReportTarget =
    (reportRoute && !projects.some((p) => p.id === reportRoute.projectId)) ||
    (hash.includes('/report/') && !reportRoute);
  return (
    <div className="workspace-root">
      {ownedBars}
      {projects
        .filter((p) => visited.includes(p.id) || p.id === project.id)
        .map((p) => (
          <div
            key={p.id}
            className={
              route || invalidReportTarget || p.id !== project.id
                ? 'workspace-hidden'
                : undefined
            }
          >
            <Workspace
              active={!route && !invalidReportTarget && p.id === project.id}
              session={session}
              project={p}
              signin={state}
              resume={resume}
              recoveryWorkspaces={recoveryWorkspaces}
              pmRegistry={pmRegistry!}
              forecastEnabled={forecastEnabled}
              {...(weatherPorts ? { weatherPorts } : {})}
              {...(reportRoute?.projectId === p.id
                ? { requestedDate: reportRoute.businessDate }
                : {})}
              onDateChange={(date) => {
                reportDates.current.set(p.id, date);
                if (p.id === project.id) openReport(p.id, date);
              }}
              onExecutiveHome={() => {
                window.location.hash = executiveHref({ kind: 'home' });
              }}
            />
          </div>
        ))}
      {invalidReportTarget && (
        <main className="page">
          <p role="alert">{t('noProject')}</p>
          <a href={executiveHref({ kind: 'home' })}>{t('execHomeTitle')}</a>
        </main>
      )}
      {showExecutiveHome && executiveApi && (
        <ExecutiveHome
          api={executiveApi}
          projects={projects}
          statusSession={getStatusSession}
          onBack={() => openReport()}
          onOpenProject={(id) => {
            window.location.hash = executiveHref({
              kind: 'overview',
              projectId: id,
            });
          }}
          onOpenAttention={() => {
            window.location.hash = executiveHref({ kind: 'attention' });
          }}
          onOpenAttentionItem={(item) => {
            window.location.hash = executiveHref(
              item.kind === 'ESCALATED_ISSUE'
                ? { kind: 'issue', projectId: item.projectId, issueId: item.id }
                : {
                    kind: 'overview',
                    projectId: item.projectId,
                    statusId: item.id,
                  },
            );
          }}
        />
      )}
      {unavailableRoute && (
        <main className="page">
          <p role="alert">{t('noProject')}</p>
          <a href={executiveHref({ kind: 'home' })}>{t('execHomeTitle')}</a>
        </main>
      )}
      {route?.kind === 'overview' && routedProject && executiveApi && (
        <ProjectOverview
          key={routedProject.id}
          session={getOverviewSession(routedProject.id)}
          {...(route.statusId ? { statusId: route.statusId } : {})}
          onReport={() => openReport(routedProject.id)}
        />
      )}
      {route?.kind === 'attention' && executiveApi && (
        <AttentionInbox api={executiveApi} projects={projects} />
      )}
      {route?.kind === 'issue' && routedProject && executiveApi && (
        <ProjectIssueEntry
          key={`${routedProject.id}:${route.issueId}`}
          api={executiveApi}
          project={routedProject}
          issueId={route.issueId}
          onReport={() => openReport(routedProject.id)}
        />
      )}
    </div>
  );
}

export function App({
  weatherPorts,
  forecastEnabled = false,
}: {
  weatherPorts?: WeatherPresentationPorts;
  forecastEnabled?: boolean;
} = {}) {
  return (
    <I18nProvider>
      <Root
        forecastEnabled={forecastEnabled}
        {...(weatherPorts ? { weatherPorts } : {})}
      />
    </I18nProvider>
  );
}
