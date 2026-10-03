import {
  useEffect,
  useMemo,
  useReducer,
  useState,
  type FormEvent,
} from 'react';
import type {
  ProjectHomeCard,
  ProjectHomeGroupBy,
  ProjectHomeState,
  ProjectStatus,
  ProjectStatusHistoryDto,
  StatusArea,
} from '@mje/contracts';
import type { Project, ReportApi } from '../api.js';
import { useI18n } from '../i18n.js';
import { Icon } from '../icons.js';
import {
  ProjectStatusSession,
  STATUS_CONFLICT_FIELDS,
  type StatusConflict,
  type StatusConflictChoices,
  type StatusConflictField,
} from './status-session.js';
import { ErrorText } from '../field/ErrorText.js';

type Props = {
  api: Pick<ReportApi, 'projectHome' | 'projectAttention'>;
  projects: Project[];
  statusSession: (projectId: string) => ProjectStatusSession;
  onBack: () => void;
  onOpenProject: (projectId: string) => void;
};

const STATES: ProjectHomeState[] = [
  'OFF_TRACK',
  'AT_RISK',
  'STALE',
  'PAUSED',
  'UNDECLARED',
  'NORMAL',
];
const GROUPS: ProjectHomeGroupBy[] = ['region', 'manager', 'type'];
const AREAS: StatusArea[] = [
  'SCHEDULE',
  'RESOURCE',
  'SAFETY',
  'QUALITY',
  'EXTERNAL',
];
type Translate = ReturnType<typeof useI18n>['t'];

function statusLabel(t: Translate, state: ProjectHomeState) {
  switch (state) {
    case 'NORMAL':
      return t('execStatusNormal');
    case 'AT_RISK':
      return t('execStatusAtRisk');
    case 'OFF_TRACK':
      return t('execStatusOffTrack');
    case 'PAUSED':
      return t('execStatusPaused');
    case 'STALE':
      return t('execStatusStale');
    case 'UNDECLARED':
      return t('execStatusUndeclared');
  }
}

function groupLabel(t: Translate, group: ProjectHomeGroupBy) {
  switch (group) {
    case 'region':
      return t('execGroupRegion');
    case 'manager':
      return t('execGroupManager');
    case 'type':
      return t('execGroupType');
  }
}

function areaLabel(t: Translate, area: StatusArea) {
  switch (area) {
    case 'SCHEDULE':
      return t('execAreaSchedule');
    case 'RESOURCE':
      return t('execAreaResource');
    case 'SAFETY':
      return t('execAreaSafety');
    case 'QUALITY':
      return t('execAreaQuality');
    case 'EXTERNAL':
      return t('execAreaExternal');
  }
}

function conflictFieldLabel(t: Translate, field: StatusConflictField) {
  switch (field) {
    case 'status':
      return t('execStatusLabel');
    case 'areas':
      return t('execAreas');
    case 'situation':
      return t('execSituation');
    case 'recovery':
      return t('execRecovery');
    case 'expectedRecoveryDate':
      return t('execExpectedRecovery');
    case 'expectedRecoveryUnknown':
      return t('execRecoveryUnknown');
    case 'needsSupport':
      return t('execNeedsSupport');
    case 'supportNote':
      return t('execSupportNote');
  }
}

function conflictValue(
  t: Translate,
  field: StatusConflictField,
  payload: StatusConflict['mine'],
) {
  if (field === 'status') return statusLabel(t, payload.status);
  if (field === 'areas')
    return (
      payload.areas.map((area) => areaLabel(t, area)).join(', ') ||
      t('execBlankValue')
    );
  const value = payload[field];
  if (typeof value === 'boolean')
    return value ? t('execBooleanTrue') : t('execBooleanFalse');
  if (value === null) return t('none');
  return value || t('execBlankValue');
}

function completionLabel(
  t: Translate,
  state: 'NOT_FROZEN' | 'UNCONFIGURED' | 'NOT_COMPUTABLE',
) {
  switch (state) {
    case 'NOT_FROZEN':
      return t('execCompletionNOT_FROZEN');
    case 'UNCONFIGURED':
      return t('execCompletionUNCONFIGURED');
    case 'NOT_COMPUTABLE':
      return t('execCompletionNOT_COMPUTABLE');
  }
}

function forecastLabel(t: Translate, state: 'NOT_COMPUTABLE' | 'AT_DESIGN') {
  return state === 'AT_DESIGN'
    ? t('execForecastAT_DESIGN')
    : t('execForecastNOT_COMPUTABLE');
}

function attentionLabel(
  t: Translate,
  kind: 'SUPPORT' | 'ESCALATED_ISSUE' | 'STATUS_CHANGED',
) {
  switch (kind) {
    case 'SUPPORT':
      return t('execAttentionSUPPORT');
    case 'ESCALATED_ISSUE':
      return t('execAttentionESCALATED_ISSUE');
    case 'STATUS_CHANGED':
      return t('execAttentionSTATUS_CHANGED');
  }
}

function hintLabel(t: Translate, hint: ProjectHomeCard['hints'][number]) {
  switch (hint.code) {
    case 'MISSING_REPORT':
      return t('execHintMissingReport', { count: hint.count ?? 0 });
    case 'OPEN_ESCALATION':
      return t('execHintEscalation', { count: hint.count ?? 0 });
    case 'FORECAST_AFTER_PLAN':
      return t('execHintForecastAfter', { date: hint.expectedDate ?? '' });
    case 'BELOW_BASELINE':
      return t('execHintBelowBaseline');
  }
}

function localDate(value: string, locale: string) {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(locale, {
        day: 'numeric',
        month: 'short',
      }).format(date);
}

function localInstant(
  value: string,
  locale: string,
  timezone: string | undefined,
) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (!timezone) return date.toISOString();
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timezone,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function stateClass(state: ProjectHomeState) {
  if (state === 'NORMAL') return 'exec-state good';
  if (state === 'UNDECLARED') return 'exec-state muted';
  if (state === 'STALE') return 'exec-state stale';
  return 'exec-state risk';
}

export function ExecutiveHome({
  api,
  projects,
  statusSession,
  onBack,
  onOpenProject,
}: Props) {
  const { t, locale } = useI18n();
  const [groupBy, setGroupBy] = useState<ProjectHomeGroupBy>('region');
  const [status, setStatus] = useState<ProjectHomeState | null>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [home, setHome] = useState<Awaited<
    ReturnType<ReportApi['projectHome']>
  > | null>(null);
  const [attention, setAttention] = useState<Awaited<
    ReturnType<ReportApi['projectAttention']>
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attentionError, setAttentionError] = useState(false);
  const [statusProjectId, setStatusProjectId] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    const timer = setTimeout(
      () => {
        setLoading(true);
        api
          .projectHome({ group: groupBy, status, q: query, page, size: 50 })
          .then((value) => {
            if (!current) return;
            setHome(value);
            setLoadError(null);
          })
          .catch(() => {
            if (!current) return;
            setLoadError('REQUEST_FAILED');
          })
          .finally(() => {
            if (current) setLoading(false);
          });
      },
      query ? 180 : 0,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, groupBy, status, query, page, refreshEpoch]);

  useEffect(() => {
    let current = true;
    api
      .projectAttention()
      .then((value) => {
        if (current) {
          setAttention(value);
          setAttentionError(false);
        }
      })
      .catch(() => {
        if (current) setAttentionError(true);
      });
    return () => {
      current = false;
    };
  }, [api, refreshEpoch]);

  const accessByProject = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const currentStatusCard = home?.groups
    .flatMap((group) => group.projects)
    .find((project) => project.id === statusProjectId);
  const pages = home ? Math.max(1, Math.ceil(home.total / home.size)) : 1;

  const chooseGroup = (next: ProjectHomeGroupBy) => {
    setGroupBy(next);
    setPage(1);
  };
  const chooseStatus = (next: ProjectHomeState | null) => {
    setStatus(next);
    setPage(1);
  };

  if (statusProjectId && currentStatusCard) {
    const project = accessByProject.get(statusProjectId);
    if (project?.access === 'write')
      return (
        <StatusPage
          api={api}
          apiProjectName={currentStatusCard.name}
          card={currentStatusCard}
          session={statusSession(statusProjectId)}
          onBack={() => {
            setStatusProjectId(null);
            setRefreshEpoch((epoch) => epoch + 1);
          }}
        />
      );
  }

  const counts = home?.counts;
  return (
    <div className="content exec-content">
      <header className="bar exec-bar">
        <button
          type="button"
          className="icon"
          aria-label={t('back')}
          onClick={onBack}
        >
          <Icon.back />
        </button>
        <div className="bar-title">
          <strong>{t('execHomeTitle')}</strong>
          <span className="bar-sub">{t('execHomeSubtitle')}</span>
        </div>
        <button
          type="button"
          className="icon"
          aria-label={t('execRefresh')}
          disabled={loading}
          onClick={() => setRefreshEpoch((value) => value + 1)}
        >
          <Icon.refresh />
        </button>
      </header>
      <main className="page exec-page">
        {loadError && (
          <div className="banner err" role="alert">
            {t('execLoadError', { code: loadError })}
            <button
              type="button"
              className="textbtn"
              onClick={() => setRefreshEpoch((value) => value + 1)}
            >
              {t('retry')}
            </button>
          </div>
        )}
        <section className="exec-counts" aria-label={t('execStatusSummary')}>
          <button
            type="button"
            className="exec-count"
            onClick={() => chooseStatus(null)}
          >
            <b>{home?.total ?? '—'}</b>
            <span>{t('execProjects')}</span>
          </button>
          {(['OFF_TRACK', 'AT_RISK', 'STALE', 'UNDECLARED'] as const).map(
            (key) => (
              <button
                type="button"
                key={key}
                className={`exec-count ${status === key ? 'selected' : ''}`}
                onClick={() => chooseStatus(status === key ? null : key)}
              >
                <b>{counts?.[key] ?? '—'}</b>
                <span>{statusLabel(t, key)}</span>
              </button>
            ),
          )}
        </section>

        <section className="card exec-controls">
          <label className="exec-search">
            <span>{t('execSearch')}</span>
            <input
              value={query}
              maxLength={160}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <label>
            <span>{t('execFilterStatus')}</span>
            <select
              value={status ?? ''}
              onChange={(event) =>
                chooseStatus(
                  (event.target.value || null) as ProjectHomeState | null,
                )
              }
            >
              <option value="">{t('execAllStatuses')}</option>
              {STATES.map((value) => (
                <option key={value} value={value}>
                  {statusLabel(t, value)}
                </option>
              ))}
            </select>
          </label>
          <div
            className="exec-groups"
            role="group"
            aria-label={t('execGroupBy')}
          >
            {GROUPS.map((value) => (
              <button
                type="button"
                key={value}
                className={`pill ${groupBy === value ? 'accent' : ''}`}
                aria-pressed={groupBy === value}
                onClick={() => chooseGroup(value)}
              >
                {groupLabel(t, value)}
              </button>
            ))}
          </div>
        </section>

        {loading && !home && <div className="muted">{t('loading')}</div>}
        {home && home.total === 0 && (
          <div className="card muted">{t('execNoProjects')}</div>
        )}
        {home?.groups.map((group) => {
          const exceptionCount = group.projects.filter(
            (project) => project.status.value !== 'NORMAL',
          ).length;
          return (
            <details
              className="exec-group"
              key={group.key}
              open={exceptionCount > 0 || undefined}
            >
              <summary>
                <span>{group.key}</span>
                <span className="muted">{group.count}</span>
              </summary>
              <div className="exec-cards">
                {group.projects.map((project) => {
                  const canPublish =
                    accessByProject.get(project.id)?.access === 'write';
                  return (
                    <ProjectCard
                      key={project.id}
                      card={project}
                      canPublish={canPublish}
                      onOpen={() => onOpenProject(project.id)}
                      onStatus={() => setStatusProjectId(project.id)}
                    />
                  );
                })}
              </div>
            </details>
          );
        })}
        {home && pages > 1 && (
          <div className="exec-pagination">
            <button
              type="button"
              className="ghost small"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              {t('execPageOf', { page: Math.max(1, page - 1), pages })}
            </button>
            <span>{t('execPageOf', { page, pages })}</span>
            <button
              type="button"
              className="ghost small"
              disabled={page >= pages}
              onClick={() => setPage(page + 1)}
            >
              {t('execPageOf', { page: Math.min(pages, page + 1), pages })}
            </button>
          </div>
        )}

        <section className="exec-attention">
          <h2>{t('attention', { n: attention?.items.length ?? '—' })}</h2>
          {attentionError && (
            <div className="banner warn">{t('execAttentionUnavailable')}</div>
          )}
          {attention && attention.items.length === 0 && (
            <div className="card muted">{t('execNoAttention')}</div>
          )}
          {attention?.items.map((item) => (
            <button
              type="button"
              className="card exec-attention-row"
              key={`${item.kind}:${item.projectId}:${item.id}`}
              onClick={() => onOpenProject(item.projectId)}
            >
              <span className="exec-attention-kind">
                {attentionLabel(t, item.kind)}
              </span>
              <b>
                {item.projectCode} · {item.projectName}
              </b>
              <span>{item.title}</span>
              {item.at && (
                <small className="muted">
                  {localInstant(
                    item.at,
                    locale,
                    accessByProject.get(item.projectId)?.timezone,
                  ) ?? t('unknown')}
                </small>
              )}
            </button>
          ))}
        </section>
      </main>
    </div>
  );
}

function ProjectCard({
  card,
  canPublish,
  onOpen,
  onStatus,
}: {
  card: ProjectHomeCard;
  canPublish: boolean;
  onOpen: () => void;
  onStatus: () => void;
}) {
  const { t, locale, label } = useI18n();
  const completion =
    card.completion.state === 'COMPUTABLE'
      ? `${card.completion.percent}%`
      : completionLabel(t, card.completion.state);
  const forecast =
    card.forecast.state === 'ESTIMATE'
      ? t('execForecastDate', {
          date: localDate(card.forecast.expectedDate, locale),
          days: card.forecast.sampleDays,
        })
      : forecastLabel(t, card.forecast.state);
  const openByDefault = card.status.value !== 'NORMAL';
  return (
    <article className="card exec-card">
      <div className="exec-card-head">
        <button type="button" className="exec-project-link" onClick={onOpen}>
          <span className="exec-code">{card.code}</span>
          <strong>{card.name}</strong>
        </button>
        <span className={stateClass(card.status.value)}>
          {statusLabel(t, card.status.value)}
        </span>
      </div>
      <div className="exec-meta">
        <span>{card.region ? label(card.region) : t('execNoRegion')}</span>
        <span>
          {card.projectType ? label(card.projectType) : t('execNoType')}
        </span>
        <span>
          {card.managers.length
            ? card.managers.map((manager) => manager.displayName).join(' · ')
            : t('execUnassigned')}
        </span>
      </div>
      <div className="exec-manager-status">
        <span>{t('execManagerDeclaration')}</span>
        <b>
          {card.status.declaredStatus
            ? statusLabel(t, card.status.declaredStatus)
            : t('execNoDeclaration')}
        </b>
        {card.status.businessDate && (
          <small>
            {t('execDeclaredOn', { date: card.status.businessDate })}
          </small>
        )}
        {card.status.staleDays !== null && (
          <small>{t('execStaleDays', { days: card.status.staleDays })}</small>
        )}
      </div>
      <div className="exec-metrics">
        <span>
          <small>{t('execCompletion')}</small>
          <b>
            {completion}
            {card.completion.state === 'COMPUTABLE' &&
            card.completion.aboveDesign
              ? ` · ${t('execAboveDesign')}`
              : ''}
          </b>
        </span>
        <span>
          <small>{t('execForecast')}</small>
          <b>{forecast}</b>
        </span>
      </div>
      <div className="exec-report-week" aria-label={t('execLastSevenReports')}>
        {card.reportsLast7.map((day) => (
          <span
            key={day.businessDate}
            className={day.submitted ? 'submitted' : 'missing'}
            title={`${day.businessDate}: ${day.submitted ? t('execReportSubmitted') : t('execReportMissing')}`}
          >
            {localDate(day.businessDate, locale)}
          </span>
        ))}
      </div>
      {card.hints.length > 0 && (
        <div className="exec-hints" aria-label={t('execSystemHints')}>
          <b>{t('execSystemHints')}</b>
          {card.hints.map((hint) => (
            <span key={hint.code} className="exec-hint">
              <Icon.alert />
              {hintLabel(t, hint)}
            </span>
          ))}
        </div>
      )}
      <div className="exec-card-actions">
        {canPublish && (
          <button type="button" className="ghost small" onClick={onStatus}>
            {t('execPublishStatus')}
          </button>
        )}
        <button type="button" className="textbtn" onClick={onOpen}>
          {t('execOpenProject')}
        </button>
      </div>
      {openByDefault && (
        <span className="sr-only">{t('execExceptionExpanded')}</span>
      )}
    </article>
  );
}

function StatusPage({
  api,
  apiProjectName,
  card,
  session,
  onBack,
}: {
  api: Pick<ReportApi, 'projectHome'>;
  apiProjectName: string;
  card: ProjectHomeCard;
  session: ProjectStatusSession;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [summary, setSummary] = useState<{
    history: ProjectStatusHistoryDto;
    card: ProjectHomeCard;
  } | null>(null);
  const [summaryError, setSummaryError] = useState(false);
  const [comparison, setComparison] = useState<StatusConflict | null>(null);
  const [choices, setChoices] = useState<StatusConflictChoices>({});
  useEffect(() => {
    const unsubscribe = session.subscribe(redraw);
    if (!session.read.data && !session.read.busy) void session.load();
    return unsubscribe;
  }, [session]);
  const history = session.read.data;
  useEffect(() => {
    let current = true;
    setSummary(null);
    setSummaryError(false);
    if (history) {
      void api
        .projectHome({
          group: 'region',
          status: null,
          q: card.code,
          page: 1,
          size: 50,
        })
        .then((value) => {
          if (!current) return;
          const fresh = value.groups
            .flatMap((group) => group.projects)
            .find((project) => project.id === card.id);
          if (fresh) setSummary({ history, card: fresh });
          else setSummaryError(true);
        })
        .catch(() => {
          if (current) setSummaryError(true);
        });
    }
    return () => {
      current = false;
    };
  }, [api, card.id, card.code, history]);
  const currentSummary = summary?.history === history ? summary.card : null;
  const draft = session.commands.owned ? null : session.draft;
  const requiredFields = session.requiredFields;
  const conflictFields =
    comparison && session.conflictIsCurrent(comparison)
      ? session.conflictRequiredFields(comparison, choices)
      : [];
  const owned = session.ownedSnapshot;
  const readLatest = session.read.data?.updates[0] ?? null;
  const latest = readLatest?.status ?? card.status.declaredStatus;
  const statusValue = (session.draft?.status ??
    latest ??
    'NORMAL') as ProjectStatus;
  const statusChoices: ProjectStatus[] = [
    'NORMAL',
    'AT_RISK',
    'OFF_TRACK',
    'PAUSED',
  ];
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void session.publish();
  };
  return (
    <div className="content exec-content">
      <header className="bar exec-bar">
        <button
          type="button"
          className="icon"
          aria-label={t('back')}
          onClick={onBack}
        >
          <Icon.back />
        </button>
        <div className="bar-title">
          <strong>{t('execPublishStatus')}</strong>
          <span className="bar-sub">
            {card.code} · {apiProjectName}
          </span>
        </div>
        <button
          type="button"
          className="icon"
          aria-label={t('execRefresh')}
          onClick={() => void session.retry()}
        >
          <Icon.refresh />
        </button>
      </header>
      <main className="page exec-status-page">
        <section className="card exec-status-current">
          <span>{t('execManagerDeclaration')}</span>
          <b>{latest ? statusLabel(t, latest) : t('execNoDeclaration')}</b>
          {currentSummary ? (
            <>
              <span className={stateClass(currentSummary.status.value)}>
                {t('execSystemStatus')}:{' '}
                {statusLabel(t, currentSummary.status.value)}
              </span>
              {currentSummary.hints.map((hint) => (
                <small key={hint.code}>{hintLabel(t, hint)}</small>
              ))}
            </>
          ) : summaryError ? (
            <div className="banner err" role="alert">
              <ErrorText code="REQUEST_FAILED" />
            </div>
          ) : (
            <span role="status">{t('loading')}</span>
          )}
          {session.read.readError && (
            <div className="banner err" role="alert">
              <ErrorText code={session.read.readError} />
            </div>
          )}
          {session.read.error &&
            session.read.error !== 'STALE' &&
            !(
              session.read.error === 'STATUS_FIELDS_REQUIRED' &&
              requiredFields.length > 0
            ) && (
              <div className="banner err" role="alert">
                <ErrorText
                  code={session.read.error}
                  write
                  uncertain={session.lastAttemptMayBeRecorded}
                />
              </div>
            )}
          {session.lastAttemptMayBeRecorded && (
            <div className="banner warn" role="alert">
              {t('execMayBeRecorded')}
            </div>
          )}
          {session.savedNeedsRefresh && (
            <div className="banner warn" role="status">
              {t('execSavedNeedsRefresh')}{' '}
              <button
                type="button"
                className="textbtn"
                onClick={() => void session.retry()}
              >
                {t('execRefresh')}
              </button>
            </div>
          )}
          {session.permissionLost && (
            <div className="banner err" role="alert">
              {t('execPermissionChanged')}
            </div>
          )}
          {session.commands.owned && owned && (
            <div className="exec-owned" role="status">
              <b>{t('execPendingDeclaration')}</b>
              <span>
                {statusLabel(t, owned.status)} ·{' '}
                {t('execVersion', { n: owned.expectedN })}
              </span>
              <span>{owned.situation || t('execNoSituation')}</span>
              {session.commands.unresolved !== null ? (
                <div className="exec-card-actions">
                  <button
                    type="button"
                    className="primary small"
                    onClick={() => void session.retry()}
                  >
                    {t('retry')}
                  </button>
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => void session.abandon()}
                  >
                    {t('execGiveUp')}
                  </button>
                </div>
              ) : (
                <span role="status">{t('saving')}</span>
              )}
            </div>
          )}
        </section>

        {session.read.data &&
          !session.commands.owned &&
          !session.permissionLost && (
            <form className="card exec-status-form" onSubmit={onSubmit}>
              <div className="blk-row">
                <h2 className="blk">{t('execStatusForm')}</h2>
                <span className="muted">
                  {t('execVersion', {
                    n: draft?.expectedN ?? session.read.data.currentN,
                  })}
                </span>
              </div>
              {draft && draft.expectedN !== session.read.data.currentN && (
                <div className="banner warn" role="alert">
                  {t('execVersionChanged')}{' '}
                  <button
                    className="textbtn"
                    type="button"
                    onClick={() => {
                      setComparison(session.reviewConflict());
                      setChoices({});
                    }}
                  >
                    {t('execReloadForm')}
                  </button>
                </div>
              )}
              {comparison && session.conflictIsCurrent(comparison) && (
                <section className="exec-conflict">
                  <p>{t('execConflictChoices')}</p>
                  {STATUS_CONFLICT_FIELDS.map((field) => (
                    <fieldset
                      key={field}
                      disabled={session.locked}
                      aria-invalid={
                        field !== 'status' && conflictFields.includes(field)
                      }
                    >
                      <legend>{conflictFieldLabel(t, field)}</legend>
                      <p className="exec-conflict-value">
                        {t('retainedLine', {
                          mine: conflictValue(t, field, comparison.mine),
                          now: conflictValue(t, field, comparison.latest),
                        })}
                      </p>
                      <label className="checkline">
                        <input
                          type="radio"
                          name={`conflict-${field}`}
                          checked={choices[field] === 'mine'}
                          onChange={() =>
                            setChoices((previous) => ({
                              ...previous,
                              [field]: 'mine',
                            }))
                          }
                        />
                        {t('execConflictMine')}
                      </label>
                      <label className="checkline">
                        <input
                          type="radio"
                          name={`conflict-${field}`}
                          checked={choices[field] === 'latest'}
                          onChange={() =>
                            setChoices((previous) => ({
                              ...previous,
                              [field]: 'latest',
                            }))
                          }
                        />
                        {t('execConflictLatest')}
                      </label>
                    </fieldset>
                  ))}
                  {conflictFields.length > 0 && (
                    <div className="banner err" role="alert">
                      {t('fe_statusFieldsRequired')}
                      <ul>
                        {conflictFields.map((field) => (
                          <li key={field}>{conflictFieldLabel(t, field)}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <button
                    type="button"
                    className="primary wide"
                    disabled={
                      session.locked ||
                      conflictFields.length > 0 ||
                      !STATUS_CONFLICT_FIELDS.every((field) => choices[field])
                    }
                    onClick={() => {
                      if (session.confirmConflict(comparison, choices)) {
                        setComparison(null);
                        setChoices({});
                      }
                    }}
                  >
                    {t('execConflictConfirm', {
                      n: comparison.history.currentN,
                    })}
                  </button>
                </section>
              )}
              {requiredFields.length > 0 && (
                <div
                  className="banner err"
                  role="alert"
                  id="exec-required-fields"
                >
                  {t('fe_statusFieldsRequired')}
                  <ul>
                    {requiredFields.map((field) => (
                      <li key={field}>{conflictFieldLabel(t, field)}</li>
                    ))}
                  </ul>
                </div>
              )}
              <label>
                <span>{t('execStatusLabel')}</span>
                <select
                  value={statusValue}
                  disabled={session.locked || !draft}
                  onChange={(event) =>
                    session.edit({
                      status: event.target.value as ProjectStatus,
                    })
                  }
                >
                  {statusChoices.map((value) => (
                    <option key={value} value={value}>
                      {statusLabel(t, value)}
                    </option>
                  ))}
                </select>
              </label>
              {statusValue !== 'NORMAL' && (
                <fieldset
                  className="exec-area-fieldset"
                  aria-invalid={requiredFields.includes('areas')}
                  aria-describedby={
                    requiredFields.includes('areas')
                      ? 'exec-required-fields'
                      : undefined
                  }
                  disabled={session.locked || !draft}
                >
                  <legend>{t('execAreas')}</legend>
                  <div className="exec-area-options">
                    {AREAS.map((value) => (
                      <label className="checkline" key={value}>
                        <input
                          type="checkbox"
                          checked={Boolean(draft?.areas.includes(value))}
                          onChange={(event) => {
                            const areas = draft?.areas ?? [];
                            session.edit({
                              areas: event.target.checked
                                ? [...areas, value]
                                : areas.filter((area) => area !== value),
                            });
                          }}
                        />
                        {areaLabel(t, value)}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              <label>
                <span>{t('execSituation')}</span>
                <textarea
                  rows={3}
                  maxLength={4000}
                  value={draft?.situation ?? ''}
                  aria-invalid={requiredFields.includes('situation')}
                  aria-describedby={
                    requiredFields.includes('situation')
                      ? 'exec-required-fields'
                      : undefined
                  }
                  disabled={session.locked || !draft}
                  onChange={(event) =>
                    session.edit({ situation: event.target.value })
                  }
                />
              </label>
              <label>
                <span>{t('execRecovery')}</span>
                <textarea
                  rows={3}
                  maxLength={4000}
                  value={draft?.recovery ?? ''}
                  aria-invalid={requiredFields.includes('recovery')}
                  aria-describedby={
                    requiredFields.includes('recovery')
                      ? 'exec-required-fields'
                      : undefined
                  }
                  disabled={session.locked || !draft}
                  onChange={(event) =>
                    session.edit({ recovery: event.target.value })
                  }
                />
              </label>
              {statusValue !== 'NORMAL' && (
                <div className="exec-recovery-date">
                  <label>
                    <span>{t('execExpectedRecovery')}</span>
                    <input
                      type="date"
                      aria-invalid={requiredFields.includes(
                        'expectedRecoveryDate',
                      )}
                      aria-describedby={
                        requiredFields.includes('expectedRecoveryDate')
                          ? 'exec-required-fields'
                          : undefined
                      }
                      value={draft?.expectedRecoveryDate ?? ''}
                      disabled={
                        session.locked ||
                        !draft ||
                        draft.expectedRecoveryUnknown
                      }
                      onChange={(event) =>
                        session.edit({
                          expectedRecoveryDate: event.target.value || null,
                        })
                      }
                    />
                  </label>
                  <label className="checkline">
                    <input
                      type="checkbox"
                      checked={draft?.expectedRecoveryUnknown ?? false}
                      aria-invalid={requiredFields.includes(
                        'expectedRecoveryUnknown',
                      )}
                      aria-describedby={
                        requiredFields.includes('expectedRecoveryUnknown')
                          ? 'exec-required-fields'
                          : undefined
                      }
                      disabled={session.locked || !draft}
                      onChange={(event) =>
                        session.edit({
                          expectedRecoveryUnknown: event.target.checked,
                        })
                      }
                    />
                    {t('execRecoveryUnknown')}
                  </label>
                </div>
              )}
              <label className="checkline">
                <input
                  type="checkbox"
                  checked={draft?.needsSupport ?? false}
                  aria-invalid={requiredFields.includes('needsSupport')}
                  aria-describedby={
                    requiredFields.includes('needsSupport')
                      ? 'exec-required-fields'
                      : undefined
                  }
                  disabled={
                    session.locked || !draft || statusValue === 'NORMAL'
                  }
                  onChange={(event) =>
                    session.edit({ needsSupport: event.target.checked })
                  }
                />
                {t('execNeedsSupport')}
              </label>
              {draft?.needsSupport && (
                <label>
                  <span>{t('execSupportNote')}</span>
                  <textarea
                    rows={2}
                    maxLength={4000}
                    value={draft.supportNote}
                    aria-invalid={requiredFields.includes('supportNote')}
                    aria-describedby={
                      requiredFields.includes('supportNote')
                        ? 'exec-required-fields'
                        : undefined
                    }
                    disabled={session.locked}
                    onChange={(event) =>
                      session.edit({ supportNote: event.target.value })
                    }
                  />
                </label>
              )}
              <button
                type="submit"
                className="primary wide"
                disabled={
                  session.locked ||
                  !draft ||
                  requiredFields.length > 0 ||
                  draft.expectedN !== session.read.data.currentN
                }
              >
                {t('execPublishStatus')}
              </button>
            </form>
          )}
        {!session.read.data && !session.read.busy && (
          <button
            type="button"
            className="primary"
            onClick={() => void session.retry()}
          >
            {t('retry')}
          </button>
        )}
      </main>
    </div>
  );
}
