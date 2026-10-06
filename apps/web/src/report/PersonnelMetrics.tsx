import { useSyncExternalStore } from 'react';
import { ROLE_KEYS } from '@mje/contracts';
import type {
  PeopleWindowSummaryDto,
  PersonnelCategory,
  PersonnelCategorySubtotalDto,
  PersonnelCellState,
  PersonnelTotalState,
} from '@mje/contracts';
import { PersonnelMetricsSession } from './personnel-metrics-session.js';

/** Supplied by the existing report/i18n integrator; no second translation registry. */
export interface PersonnelMetricsLabels {
  title: string;
  description: string;
  category: string;
  knownSubtotal: string;
  coverageTitle: string;
  contributions: string;
  state: string;
  noValue: string;
  loading: string;
  refreshError: string;
  retry: string;
  historicalUnavailable: string;
  categories: Record<PersonnelCategory, string>;
  cellStates: Record<PersonnelCellState, string>;
  totalStates: Record<PersonnelTotalState, string>;
  period: (from: string, to: string) => string;
  coverage: (reported: number, slots: number) => string;
  categoryCoverage: (value: PersonnelCategorySubtotalDto) => string;
  selectedAt: (utc: string) => string;
  openRevision: (date: string, n: number) => string;
}
export type PersonnelRevisionLink = {
  projectId: string;
  businessDate: string;
  reportRevisionId: string;
  n: number;
};
type SharedProps = {
  labels: PersonnelMetricsLabels;
  onOpenRevision: (target: PersonnelRevisionLink) => void;
};
export type PersonnelMetricsProps = SharedProps &
  (
    | { mode: 'current'; session: PersonnelMetricsSession }
    | { mode: 'frozen'; summary: PeopleWindowSummaryDto | null }
  );

/** Read-only addition to the approved personnel card; daily inputs keep their existing owner. */
export function PersonnelMetrics(props: PersonnelMetricsProps) {
  return props.mode === 'current' ? (
    <CurrentPersonnelMetrics {...props} />
  ) : props.summary === null ? (
    <p>{props.labels.historicalUnavailable}</p>
  ) : (
    <Summary
      summary={props.summary}
      labels={props.labels}
      onOpenRevision={props.onOpenRevision}
    />
  );
}
function CurrentPersonnelMetrics(
  props: SharedProps & { session: PersonnelMetricsSession },
) {
  useSyncExternalStore(
    props.session.subscribe,
    props.session.snapshot,
    props.session.snapshot,
  );
  const summary = props.session.summary;
  return (
    <section>
      {summary ? (
        <Summary
          summary={summary}
          labels={props.labels}
          onOpenRevision={props.onOpenRevision}
        />
      ) : (
        <p role={props.session.read.readError ? 'alert' : 'status'}>
          {props.session.read.readError
            ? props.labels.refreshError
            : props.labels.loading}
        </p>
      )}
      <button
        type="button"
        onClick={() => {
          void props.session.refresh();
        }}
      >
        {props.labels.retry}
      </button>
    </section>
  );
}
function Summary({
  summary,
  labels,
  onOpenRevision,
}: SharedProps & { summary: PeopleWindowSummaryDto }) {
  return (
    <section aria-label={labels.title}>
      <h4>{labels.title}</h4>
      <p>{labels.description}</p>
      <p>
        {labels.period(summary.windowFrom, summary.windowTo)} ·{' '}
        {labels.coverage(summary.reportedDays, summary.slotDays)} ·{' '}
        {labels.totalStates[summary.totalState]}
      </p>
      <p>{labels.selectedAt(summary.selectedAtUTC)}</p>
      <table>
        <caption>{labels.knownSubtotal}</caption>
        <thead>
          <tr>
            <th scope="col">{labels.category}</th>
            <th scope="col">{labels.knownSubtotal}</th>
            <th scope="col">{labels.coverageTitle}</th>
            <th scope="col">{labels.state}</th>
          </tr>
        </thead>
        <tbody>
          {ROLE_KEYS.map((key) => (
            <tr key={key}>
              <th scope="row">{labels.categories[key]}</th>
              <td>
                {summary.categoryKnownSubtotals[key].knownSubtotal ??
                  labels.noValue}
              </td>
              <td>
                {labels.categoryCoverage(summary.categoryKnownSubtotals[key])}
              </td>
              <td>
                {labels.totalStates[summary.categoryKnownSubtotals[key].state]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <details>
        <summary>{labels.contributions}</summary>
        <ul>
          {summary.dayContributions.map((day) => (
            <li key={day.businessDate}>
              {day.reportRevisionId !== null && day.n !== null ? (
                <button
                  type="button"
                  onClick={() =>
                    onOpenRevision({
                      projectId: summary.projectId,
                      businessDate: day.businessDate,
                      reportRevisionId: day.reportRevisionId!,
                      n: day.n!,
                    })
                  }
                >
                  {labels.openRevision(day.businessDate, day.n)}
                </button>
              ) : (
                <span>
                  {day.businessDate} · {labels.cellStates.missing}
                </span>
              )}
              <dl>
                {ROLE_KEYS.map((key) => (
                  <div key={key}>
                    <dt>{labels.categories[key]}</dt>
                    <dd>
                      {day.categories[key].raw === null ||
                      day.categories[key].raw === ''
                        ? labels.cellStates[day.categories[key].state]
                        : day.categories[key].raw}{' '}
                      · {labels.cellStates[day.categories[key].state]}
                    </dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
