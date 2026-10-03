import { useEffect, useState } from 'react';
import {
  ApiError,
  type IssueItem,
  type Project,
  type ReportApi,
} from '../api.js';
import { useI18n } from '../i18n.js';
import { ErrorText } from '../field/ErrorText.js';
import { fmtDay, fmtStamp, siteToday } from '../report/format.js';
import { executiveHref } from './overview-routing.js';
import './overview.css';
/** Exact issue destination. Existing report workspace retains all issue commands. */
export function ProjectIssueEntry({
  api,
  project,
  issueId,
  onReport,
}: {
  api: Pick<ReportApi, 'issues'>;
  project: Project;
  issueId: string;
  onReport: () => void;
}) {
  const { t, locale } = useI18n();
  const [issue, setIssue] = useState<IssueItem | null>(null),
    [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true),
    [epoch, setEpoch] = useState(0);
  useEffect(() => {
    let current = true;
    setIssue(null);
    setError(null);
    setLoading(true);
    void api
      .issues(project.id, siteToday(project.timezone))
      .then((value) => {
        if (!current) return;
        if (value.projectId !== project.id) {
          setError('NOT_FOUND');
          return;
        }
        const found = value.issues.find((item) => item.id === issueId);
        if (found) setIssue(found);
        else setError('NOT_FOUND');
      })
      .catch((e) => {
        if (current)
          setError(e instanceof ApiError ? e.code : 'REQUEST_FAILED');
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [api, project.id, project.timezone, issueId, epoch]);
  return (
    <div className="overview-shell">
      <nav className="overview-nav" aria-label={t('ovNavigation')}>
        <a href={executiveHref({ kind: 'overview', projectId: project.id })}>
          {t('ovBackToOverview')}
        </a>
        <a href={executiveHref({ kind: 'attention' })}>{t('ovAttention')}</a>
      </nav>
      <main className="overview-main">
        <header className="overview-header">
          <h1>
            {project.code} · {project.name}
          </h1>
          <button type="button" onClick={() => setEpoch((n) => n + 1)}>
            {t('ovRefresh')}
          </button>
        </header>
        {loading && <p role="status">{t('loading')}</p>}
        {error && (
          <div className="banner err" role="alert">
            <ErrorText code={error} />
          </div>
        )}
        {issue && (
          <article className="card">
            <h2>{issue.title}</h2>
            {issue.dueOn && (
              <p>{t('dueBy', { d: fmtDay(issue.dueOn, locale) })}</p>
            )}
            <div className="overview-replies">
              {issue.notes.map((note) => (
                <blockquote key={note.id}>
                  <p>{note.text}</p>
                  <time dateTime={note.at}>
                    {fmtStamp(note.at, locale, project.timezone)}
                  </time>
                </blockquote>
              ))}
            </div>
            <button type="button" onClick={onReport}>
              {t('nav_report')}
            </button>
          </article>
        )}
      </main>
    </div>
  );
}
