import { useEffect, useId, useReducer, useRef } from 'react';
import type { StatusUpdateDto } from '@mje/contracts';
import { useI18n } from '../i18n.js';
import { ErrorText } from '../field/ErrorText.js';
import { fmtDay, fmtStamp } from '../report/format.js';
import { ProjectOverviewSession } from './overview-session.js';
import { cumulativeChart } from './overview-chart.js';
import { executiveHref } from './overview-routing.js';
import {
  overviewStatus,
  overviewArea,
  OverviewValue,
} from './overview-values.js';
import { workforceSummary } from './overview-workforce.js';
import './overview.css';

type Props = {
  session: ProjectOverviewSession;
  statusId?: string;
  onReport: () => void;
};
export function ProjectOverview({ session, statusId, onReport }: Props) {
  const { t, label, locale } = useI18n();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const chartId = useId();
  useEffect(() => {
    const unsubscribe = session.subscribe(rerender);
    if (
      statusId &&
      session.page !== 1 &&
      !session.data?.statusHistory.updates.some(
        (update) => update.id === statusId,
      )
    )
      void session.goToPage(1);
    else void session.load();
    return unsubscribe;
  }, [session, statusId]);
  const data = session.data;
  const primary = data?.primaryWorkItem ?? null;
  const chart = cumulativeChart(data?.cumulative ?? [], primary);
  const error = session.read.readError;
  return (
    <div className="overview-shell">
      <nav className="overview-nav" aria-label={t('ovNavigation')}>
        <a href={executiveHref({ kind: 'home' })}>{t('execHomeTitle')}</a>
        <a href={executiveHref({ kind: 'attention' })}>{t('ovAttention')}</a>
        <button type="button" onClick={onReport}>
          {t('nav_report')}
        </button>
      </nav>
      <main className="overview-main">
        <header className="overview-header">
          <div>
            <p className="muted">{t('ovTitle')}</p>
            <h1>
              {data
                ? `${data.projectCode} · ${data.projectName}`
                : t('ovTitle')}
            </h1>
          </div>
          <button
            type="button"
            disabled={session.read.busy || session.commands.owned}
            onClick={() => void session.load()}
          >
            {t('ovRefresh')}
          </button>
        </header>
        {error && (
          <div className="banner err" role="alert">
            <ErrorText code={error} />
          </div>
        )}
        {!data && !error && !session.permissionLost && (
          <p role="status">{t('loading')}</p>
        )}
        <ReplyRecovery session={session} />
        {data && (
          <div className="overview-grid">
            <section className="card overview-progress">
              <h2>{t('progress')}</h2>
              {!primary ? (
                <p>{t('ovNoFrozenPrimary')}</p>
              ) : (
                <>
                  <h3>
                    {label(primary.label)}{' '}
                    <small className="muted">
                      {label(`u_${primary.unit}`).replace(/^u_/, '')}
                    </small>
                  </h3>
                  <div className="overview-primary">
                    <p>
                      {t('ovDesignQuantity')}:{' '}
                      <OverviewValue value={primary.designQty} />
                    </p>
                    <p>
                      {primary.completion.state === 'COMPUTABLE' ? (
                        <>
                          <b>{primary.completion.percent}%</b>
                          {primary.completion.aboveDesign && (
                            <span className="chip warn">
                              {t('execAboveDesign')}
                            </span>
                          )}
                        </>
                      ) : primary.completion.state === 'NOT_FROZEN' ? (
                        t('execCompletionNOT_FROZEN')
                      ) : primary.completion.state === 'UNCONFIGURED' ? (
                        t('execCompletionUNCONFIGURED')
                      ) : (
                        t('execCompletionNOT_COMPUTABLE')
                      )}
                    </p>
                    <p>
                      {t('ovPrimaryForecast')}:{' '}
                      {primary.forecast.state === 'ESTIMATE'
                        ? fmtDay(primary.forecast.expectedDate, locale)
                        : primary.forecast.state === 'AT_DESIGN'
                          ? t('execForecastAT_DESIGN')
                          : t('execForecastNOT_COMPUTABLE')}
                    </p>
                    {primary.forecast.state === 'ESTIMATE' && (
                      <p className="muted">
                        {t('ovForecastSample', {
                          n: primary.forecast.sampleDays,
                        })}
                      </p>
                    )}
                    <p>
                      {t('ovPlannedDate')}:{' '}
                      {primary.plannedDate
                        ? fmtDay(primary.plannedDate, locale)
                        : t('notFilled')}
                    </p>
                  </div>
                  <p className="muted small">{t('ovForecastNote')}</p>
                </>
              )}
              <h3>{t('ovCumulative')}</h3>
              {chart.length ? (
                <svg
                  className="overview-chart"
                  viewBox="0 0 600 210"
                  role="img"
                  aria-labelledby={chartId}
                >
                  <title id={chartId}>{t('ovCumulative')}</title>
                  <path
                    d="M20 20V180H580"
                    fill="none"
                    stroke="currentColor"
                    opacity="0.3"
                  />
                  {chart.map((segment, i) => (
                    <g key={i}>
                      {segment.length > 1 && (
                        <polyline
                          points={segment.map((p) => `${p.x},${p.y}`).join(' ')}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                        />
                      )}
                      {segment.map((p) => (
                        <circle key={p.date} cx={p.x} cy={p.y} r="4">
                          <title>
                            {p.date}: {p.value}
                          </title>
                        </circle>
                      ))}
                    </g>
                  ))}
                  <text x="20" y="204">
                    {chart[0]?.[0]?.date}
                  </text>
                  <text x="580" y="204" textAnchor="end">
                    {chart.at(-1)?.at(-1)?.date}
                  </text>
                </svg>
              ) : (
                <p className="muted">{t('ovNoChart')}</p>
              )}
              <details>
                <summary>{t('ovSourceValues')}</summary>
                <div className="overview-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>{t('date')}</th>
                        <th>{t('ovCumulative')}</th>
                        <th>{t('ovSeriesIdentity')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.cumulative.map((point) => (
                        <tr key={point.businessDate}>
                          <th scope="row">
                            {fmtDay(point.businessDate, locale)}
                          </th>
                          <td>
                            <OverviewValue value={point.value} />
                          </td>
                          <td>
                            {point.workItemKey ?? t('unknown')} /{' '}
                            {point.unit ?? t('unknown')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </section>
            <section className="card overview-timeline">
              <h2>{t('ovTimeline')}</h2>
              {statusId &&
                !data.statusHistory.updates.some(
                  (update) => update.id === statusId,
                ) && <p className="banner warn">{t('ovStatusNotOnPage')}</p>}
              {!data.statusHistory.updates.length && (
                <p className="muted">{t('ovNoStatus')}</p>
              )}
              <div
                className="overview-timeline-scroll"
                tabIndex={0}
                role="region"
                aria-label={t('ovTimeline')}
              >
                {data.statusHistory.updates.map((update) => (
                  <StatusRecord
                    key={update.id}
                    update={update}
                    session={session}
                    selected={update.id === statusId}
                  />
                ))}
              </div>
              <nav
                className="overview-pagination"
                aria-label={t('ovHistoryPages')}
              >
                <button
                  type="button"
                  disabled={
                    session.page <= 1 ||
                    session.commands.owned ||
                    session.savedNeedsRefresh
                  }
                  onClick={() => void session.goToPage(session.page - 1)}
                >
                  {t('ovPrevious')}
                </button>
                <span>{t('ovPage', { n: session.page })}</span>
                <button
                  type="button"
                  disabled={
                    !session.canNext ||
                    session.commands.owned ||
                    session.savedNeedsRefresh
                  }
                  onClick={() => void session.goToPage(session.page + 1)}
                >
                  {t('ovNext')}
                </button>
              </nav>
            </section>
            <section className="card">
              <h2>{t('ovWorkItems')}</h2>
              <p className="muted small">{t('ovCurrentWorkItems')}</p>
              <div className="overview-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{t('ovWorkItems')}</th>
                      <th>{t('ovUnit')}</th>
                      <th>{t('ovDesignQuantity')}</th>
                      <th>{t('ovPlannedDate')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.workItems.map((item) => (
                      <tr key={item.key}>
                        <th scope="row">
                          {label(item.label)}
                          {!item.active && <small>{t('ovInactive')}</small>}
                        </th>
                        <td>{label(`u_${item.unit}`).replace(/^u_/, '')}</td>
                        <td>
                          <OverviewValue value={item.designQty} />
                        </td>
                        <td>
                          {item.plannedDate
                            ? fmtDay(item.plannedDate, locale)
                            : t('notFilled')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!data.workItems.length && <p>{t('ovNoWorkItems')}</p>}
            </section>
            <section className="card">
              <h2>{t('milestones')}</h2>
              <div className="overview-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{t('milestones')}</th>
                      <th>{t('ovPlannedDate')}</th>
                      <th>{t('actual')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.milestones.map((item) => (
                      <tr key={item.id}>
                        <th scope="row">
                          {label(item.label)}
                          {!item.active && <small>{t('ovInactive')}</small>}
                        </th>
                        <td>
                          {item.plannedDate
                            ? fmtDay(item.plannedDate, locale)
                            : t('notFilled')}
                        </td>
                        <td>
                          {item.actual
                            ? fmtDay(item.actual, locale)
                            : t('notFilled')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!data.milestones.length && <p>{t('ovNoMilestones')}</p>}
            </section>
            <section className="card">
              <h2>{t('ovPeople7')}</h2>
              <p className="muted small">{t('ovPeopleDeclared')}</p>
              <div className="overview-people">
                {data.peopleLast7.map((day) => (
                  <article key={day.businessDate}>
                    <h3>{fmtDay(day.businessDate, locale)}</h3>
                    {day.categories === null ? (
                      <p>{t('ovNoSubmittedReport')}</p>
                    ) : (
                      <dl>
                        <div>
                          <dt>{t('people')}</dt>
                          <dd>
                            <PeopleTotal categories={day.categories} />
                          </dd>
                        </div>
                        {Object.entries(day.categories).map(([key, value]) => (
                          <div key={key}>
                            <dt>
                              {label(`role_${key}`).replace(/^role_/, '')}
                            </dt>
                            <dd>
                              <OverviewValue value={value} />
                            </dd>
                          </div>
                        ))}
                        {Object.keys(day.categories).length === 0 && (
                          <div>
                            <dt>{t('notFilled')}</dt>
                          </div>
                        )}
                      </dl>
                    )}
                  </article>
                ))}
              </div>
            </section>
            <section className="card">
              <h2>{t('ovOpenIssues')}</h2>
              {data.openIssues.length ? (
                <ul className="overview-issue-list">
                  {data.openIssues.map((issue) => (
                    <li key={issue.id}>
                      <a
                        href={executiveHref({
                          kind: 'issue',
                          projectId: data.projectId,
                          issueId: issue.id,
                        })}
                      >
                        {issue.title}
                      </a>
                      {issue.dueOn && (
                        <p className="muted">
                          {t('dueBy', { d: fmtDay(issue.dueOn, locale) })}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{t('ovNoOpenIssues')}</p>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
function StatusRecord({
  update,
  session,
  selected,
}: {
  update: StatusUpdateDto;
  session: ProjectOverviewSession;
  selected: boolean;
}) {
  const { t, locale } = useI18n();
  const inputId = useId();
  const record = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected) record.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  const active =
    session.commands.current?.n === update.n ? session.commands.current : null;
  const text = active?.text ?? session.drafts.get(update.n) ?? '';
  return (
    <article
      ref={record}
      className={`overview-status${selected ? ' selected' : ''}`}
      id={`status-${update.id}`}
    >
      <header>
        <time dateTime={update.declaredAt}>
          {fmtStamp(update.declaredAt, locale, update.siteTimezone)}
        </time>
        <strong>{overviewStatus(t, update.status)}</strong>
      </header>
      <p className="muted small">{update.businessDate}</p>
      <p>{update.areas.map((area) => overviewArea(t, area)).join(' · ')}</p>
      {update.situation && <p>{update.situation}</p>}
      {update.recovery && (
        <p>
          <b>{t('execRecovery')}: </b>
          {update.recovery}
        </p>
      )}
      {(update.expectedRecoveryDate || update.expectedRecoveryUnknown) && (
        <p>
          {t('execExpectedRecovery')}:{' '}
          {update.expectedRecoveryDate
            ? fmtDay(update.expectedRecoveryDate, locale)
            : t('unknown')}
        </p>
      )}
      {update.needsSupport && (
        <p className="banner warn">{update.supportNote}</p>
      )}
      <div className="overview-replies">
        {update.notes.map((note) => (
          <blockquote key={note.id}>
            <p>{note.text}</p>
            <time dateTime={note.at}>
              {fmtStamp(note.at, locale, update.siteTimezone)}
            </time>
          </blockquote>
        ))}
      </div>
      {active ? (
        <p className="overview-owned-reply">{active.text}</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void session.reply(update.n);
          }}
        >
          <label htmlFor={inputId}>{t('reply')}</label>
          <textarea
            id={inputId}
            rows={2}
            maxLength={4000}
            value={text}
            disabled={session.locked}
            onChange={(e) => session.edit(update.n, e.target.value)}
          />
          <button type="submit" disabled={session.locked || !text.trim()}>
            {t('send')}
          </button>
        </form>
      )}
    </article>
  );
}

function PeopleTotal({ categories }: { categories: Record<string, string> }) {
  const { t } = useI18n();
  const result = workforceSummary(categories);
  if (result.value !== null)
    return (
      <>
        <OverviewValue value={result.value} />
        {result.state === 'partial' && (
          <span className="muted"> · {t('incomplete')}</span>
        )}
      </>
    );
  return (
    <>
      {result.state === 'blank'
        ? t('notFilled')
        : result.state === 'na'
          ? t('na')
          : t('unknown')}
    </>
  );
}

function ReplyRecovery({ session }: { session: ProjectOverviewSession }) {
  const { t } = useI18n();
  return (
    <div className="overview-recovery">
      {session.savedN !== null && (
        <p className="banner ok" role="status">
          {t('ovReplySaved')}
          {session.savedNeedsRefresh && ` · ${t('ovSavedRefresh')}`}
        </p>
      )}
      {(session.read.error || session.commands.refusal) && (
        <p className="banner warn" role="alert">
          <ErrorText
            code={session.commands.refusal ?? session.read.error}
            write
            uncertain={session.mayBeRecorded}
          />
        </p>
      )}
      {session.mayBeRecorded && !session.commands.refusal && (
        <p className="banner warn">{t('ovReplyMayBeRecorded')}</p>
      )}
      {session.retryable && (
        <div className="overview-actions">
          <button type="button" onClick={() => void session.retry()}>
            {t('retry')}
          </button>
          <button type="button" onClick={() => session.discard()}>
            {t('ovAbandonReply')}
          </button>
        </div>
      )}

      {!session.data &&
        (session.commands.current ?? session.commands.refused) && (
          <p className="overview-owned-reply">
            {(session.commands.current ?? session.commands.refused)?.text}
          </p>
        )}
    </div>
  );
}
