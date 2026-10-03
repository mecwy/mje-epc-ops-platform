import { useEffect, useState } from 'react';
import type { ProjectAttentionDto, ProjectAttentionItem } from '@mje/contracts';
import { ApiError, type Project, type ReportApi } from '../api.js';
import { useI18n } from '../i18n.js';
import { ErrorText } from '../field/ErrorText.js';
import { fmtStamp } from '../report/format.js';
import { executiveHref } from './overview-routing.js';
import './overview.css';
function attentionKind(
  t: ReturnType<typeof useI18n>['t'],
  kind: ProjectAttentionItem['kind'],
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
/** D2 visibility comes from each fresh server projection; there is no local read/dismiss state. */
export function AttentionInbox({
  api,
  projects,
}: {
  api: Pick<ReportApi, 'projectAttention'>;
  projects: Project[];
}) {
  const { t, locale } = useI18n();
  const [data, setData] = useState<ProjectAttentionDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    let current = true;
    setData(null);
    setError(null);
    void api
      .projectAttention()
      .then((value) => {
        if (current) setData(value);
      })
      .catch((e) => {
        if (current) {
          setData(null);
          setError(e instanceof ApiError ? e.code : 'REQUEST_FAILED');
        }
      });
    return () => {
      current = false;
    };
  }, [api, epoch]);
  const visible = data?.items.filter((item) =>
    projects.some((project) => project.id === item.projectId),
  );
  return (
    <div className="overview-shell">
      <nav className="overview-nav" aria-label={t('ovNavigation')}>
        <a href={executiveHref({ kind: 'home' })}>{t('execHomeTitle')}</a>
      </nav>
      <main className="overview-main">
        <header className="overview-header">
          <h1>{t('attention', { n: visible?.length ?? '—' })}</h1>
          <button type="button" onClick={() => setEpoch((n) => n + 1)}>
            {t('ovRefresh')}
          </button>
        </header>
        {error && (
          <div className="banner err" role="alert">
            <ErrorText code={error} />
          </div>
        )}
        {!data && !error && <p role="status">{t('loading')}</p>}
        {visible?.length === 0 && (
          <p className="card">{t('execNoAttention')}</p>
        )}
        <div className="overview-attention">
          {visible?.map((item) => {
            const project = projects.find((p) => p.id === item.projectId)!;
            const href = executiveHref(
              item.kind === 'ESCALATED_ISSUE'
                ? { kind: 'issue', projectId: item.projectId, issueId: item.id }
                : {
                    kind: 'overview',
                    projectId: item.projectId,
                    statusId: item.id,
                  },
            );
            return (
              <a
                className="card"
                key={`${item.kind}:${item.projectId}:${item.id}`}
                href={href}
              >
                <span className="muted">{attentionKind(t, item.kind)}</span>
                <strong>
                  {item.projectCode} · {item.projectName}
                </strong>
                <span>{item.title}</span>
                <small>
                  {item.at
                    ? fmtStamp(item.at, locale, project.timezone)
                    : t('unknown')}
                </small>
              </a>
            );
          })}
        </div>
      </main>
    </div>
  );
}
