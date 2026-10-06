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
  /** Optional compact wording supplied by the same report/i18n owner. */
  detailsTitle?: string;
  cumulativeTitle?: string;
  shortSubtotal?: string;
  shortTotalStates?: Partial<Record<PersonnelTotalState, string>>;
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
    <section className="personnel-summary" aria-label={props.labels.title}>
      <h4>{props.labels.title}</h4>
      <p className="personnel-summary-unavailable" role="status">
        {props.labels.historicalUnavailable}
      </p>
    </section>
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
    <div className="personnel-current">
      {summary ? (
        <Summary
          summary={summary}
          labels={props.labels}
          onOpenRevision={props.onOpenRevision}
        />
      ) : (
        <section className="personnel-summary" aria-label={props.labels.title}>
          <h4>{props.labels.title}</h4>
          <p role={props.session.read.readError ? 'alert' : 'status'}>
            {props.session.read.readError
              ? props.labels.refreshError
              : props.labels.loading}
          </p>
          {props.session.read.readError && (
            <button
              type="button"
              onClick={() => {
                void props.session.refresh();
              }}
            >
              {props.labels.retry}
            </button>
          )}
        </section>
      )}
    </div>
  );
}

/** Presentation of an absent subtotal; never manufacture a numeric value. */
function noKnownValue(
  value: PersonnelCategorySubtotalDto,
  labels: PersonnelMetricsLabels,
): string {
  const exclusive = (days: number) =>
    days > 0 &&
    days ===
      value.blankDays +
        value.unknownDays +
        value.notApplicableDays +
        value.invalidDays +
        value.missingFieldDays;
  if (exclusive(value.blankDays)) return labels.cellStates.blank;
  if (exclusive(value.notApplicableDays)) return labels.cellStates.na;
  if (exclusive(value.unknownDays)) return labels.cellStates.unknown;
  return labels.noValue;
}
function Summary({
  summary,
  labels,
  onOpenRevision,
}: SharedProps & { summary: PeopleWindowSummaryDto }) {
  const stateLabel = (state: PersonnelTotalState) =>
    labels.shortTotalStates?.[state] ?? labels.totalStates[state];
  return (
    <section className="personnel-summary" aria-label={labels.title}>
      <header className="personnel-summary-heading">
        <div>
          <h4>{labels.title}</h4>
          <p className="personnel-summary-period">
            {labels.period(summary.windowFrom, summary.windowTo)}
          </p>
        </div>
        <p className="personnel-summary-coverage">
          <span>{labels.coverage(summary.reportedDays, summary.slotDays)}</span>
          <span
            className="personnel-summary-state"
            data-state={summary.totalState}
          >
            {stateLabel(summary.totalState)}
          </span>
        </p>
      </header>
      <details className="personnel-summary-totals">
        <summary>{labels.cumulativeTitle ?? labels.knownSubtotal}</summary>
        <table
          className="personnel-summary-values"
          aria-label={labels.knownSubtotal}
        >
          <thead>
            <tr>
              <th scope="col">{labels.category}</th>
              <th scope="col">
                {labels.shortSubtotal ?? labels.knownSubtotal}
              </th>
            </tr>
          </thead>
          <tbody>
            {ROLE_KEYS.map((key) => {
              const value = summary.categoryKnownSubtotals[key];
              return (
                <tr key={key}>
                  <th scope="row">{labels.categories[key]}</th>
                  <td>
                    <div className="personnel-summary-value">
                      <span className="personnel-summary-number">
                        {value.knownSubtotal ?? noKnownValue(value, labels)}
                      </span>
                      {value.state !== 'complete' && (
                        <span
                          className="personnel-summary-state"
                          data-state={value.state}
                        >
                          {stateLabel(value.state)}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <details className="personnel-summary-details">
          <summary>{labels.detailsTitle ?? labels.contributions}</summary>
          <div className="personnel-summary-method">
            <p>{labels.description}</p>
            <p>{labels.selectedAt(summary.selectedAtUTC)}</p>
            <h5>{labels.coverageTitle}</h5>
            <dl className="personnel-summary-category-coverage">
              {ROLE_KEYS.map((key) => (
                <div key={key}>
                  <dt>{labels.categories[key]}</dt>
                  <dd>
                    {labels.categoryCoverage(
                      summary.categoryKnownSubtotals[key],
                    )}
                    {' · '}
                    {
                      labels.totalStates[
                        summary.categoryKnownSubtotals[key].state
                      ]
                    }
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <h5>{labels.contributions}</h5>
          <ul className="personnel-summary-days">
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
                          : `${day.categories[key].raw} · ${labels.cellStates[day.categories[key].state]}`}
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        </details>
      </details>
    </section>
  );
}
