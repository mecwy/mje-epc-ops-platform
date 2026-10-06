import type {
  Comparison,
  ReportedCellDisplay,
  SourceReportDisplayModel,
} from './source-report.js';

/** Every visible caption is supplied by the host's selected language. No API/i18n coupling. */
export interface SourceReportLabels {
  nextPlan: string;
  nextPlanMissing: string;
  targetDate: string;
  targetQuantity: string;
  approvalUnknown: string;
  title: string;
  missingVersion: string;
  unverifiedSource: string;
  sourceUnavailable: string;
  original: string;
  blank: string;
  unknown: string;
  na: string;
  absent: string;
  people: string;
  classifiedTotal: string;
  partialClassifiedTotal: string;
  workPercent: string;
  calculatedPercent: string;
  materials: string;
  today: string;
  originalCumulative: string;
  originalPercent: string;
  originalUnit: string;
  originalNote: string;
  systemCumulative: string;
  partialSystemCumulative: string;
  unit: string;
  equal: string;
  unavailable: string;
  partial: string;
  unitMismatch: string;
  unitUnavailable: string;
  difference: (value: string) => string;
  coordinates: (table: number, row: number, cell: number) => string;
  gridSpan: (value: number) => string;
  verticalMerge: (value: 'restart' | 'continue') => string;
}
const rawStyle = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as const;

function SourceCell({
  cell,
  labels,
}: {
  cell: ReportedCellDisplay | undefined;
  labels: SourceReportLabels;
}) {
  if (!cell) return <span>{labels.absent}</span>;
  const citation = cell.citation;
  return (
    <>
      {cell.state !== 'value' && <span>{labels[cell.state]} · </span>}
      <span style={rawStyle}>{cell.raw}</span>
      <details>
        <summary>{labels.unverifiedSource}</summary>
        {citation ? (
          <div style={rawStyle}>
            <p>{citation.label}</p>
            <p>SHA-256: {citation.sha256}</p>
            <p>
              {labels.coordinates(citation.table, citation.row, citation.cell)}
            </p>
            {citation.gridSpan !== undefined && (
              <p>{labels.gridSpan(citation.gridSpan)}</p>
            )}
            {citation.verticalMerge !== undefined && (
              <p>{labels.verticalMerge(citation.verticalMerge)}</p>
            )}
          </div>
        ) : (
          <p>{labels.sourceUnavailable}</p>
        )}
      </details>
    </>
  );
}
function ComparisonNote({
  comparison,
  labels,
}: {
  comparison: Comparison;
  labels: SourceReportLabels;
}) {
  return (
    <p className="muted">
      {comparison.state === 'different'
        ? labels.difference(comparison.difference)
        : labels[comparison.state]}
    </p>
  );
}
function CurrentValue({
  value,
  labels,
}: {
  value: string | null | undefined;
  labels: SourceReportLabels;
}) {
  return (
    <span style={rawStyle}>
      {value === undefined
        ? labels.absent
        : value === null
          ? labels.unknown
          : value.trim() === ''
            ? labels.blank
            : value === 'unknown'
              ? labels.unknown
              : value === 'na'
                ? labels.na
                : value}
    </span>
  );
}

/** Read-only; pass a model built entirely from the selected draft/submitted/historical view. */
export function SourceReport({
  model,
  labels,
}: {
  model: SourceReportDisplayModel;
  labels: SourceReportLabels;
}) {
  return (
    <section className="card" aria-label={labels.title}>
      <h2>{labels.title}</h2>
      {!model.recorded ? (
        <p>{labels.missingVersion}</p>
      ) : (
        <>
          <p>{labels.unverifiedSource}</p>
          <section aria-label={labels.nextPlan}>
            <h3>{labels.nextPlan}</h3>
            {model.nextPlan ? (
              <>
                <p>
                  {labels.targetDate}:{' '}
                  <time dateTime={model.nextPlan.targetBusinessDate}>
                    {model.nextPlan.targetBusinessDate}
                  </time>
                </p>
                <p>{labels.approvalUnknown}</p>
                {model.nextPlan.rows.map((row) => (
                  <article key={row.key}>
                    <h4 style={rawStyle}>{row.label}</h4>
                    <dl>
                      <dt>{labels.targetQuantity}</dt>
                      <dd>
                        <SourceCell cell={row.original} labels={labels} />
                      </dd>
                      <dt>{labels.unit}</dt>
                      <dd>{row.unit || labels.unknown}</dd>
                    </dl>
                  </article>
                ))}
              </>
            ) : (
              <p>{labels.nextPlanMissing}</p>
            )}
          </section>
          <section aria-label={labels.people}>
            <h3>{labels.people}</h3>
            <dl>
              <dt>{labels.original}</dt>
              <dd>
                <SourceCell cell={model.people.original} labels={labels} />
              </dd>
              <dt>
                {model.people.complete
                  ? labels.classifiedTotal
                  : labels.partialClassifiedTotal}
              </dt>
              <dd>
                <CurrentValue value={model.people.calculated} labels={labels} />
              </dd>
            </dl>
            <ComparisonNote
              comparison={model.people.comparison}
              labels={labels}
            />
          </section>
          {model.work.length > 0 && (
            <section aria-label={labels.workPercent}>
              <h3>{labels.workPercent}</h3>
              {model.work.map((row) => (
                <article key={row.key}>
                  <h4 style={rawStyle}>{row.label}</h4>
                  <dl>
                    <dt>{labels.original}</dt>
                    <dd>
                      <SourceCell cell={row.original} labels={labels} />
                    </dd>
                    <dt>{labels.calculatedPercent}</dt>
                    <dd>
                      {row.calculated === null
                        ? labels.unknown
                        : `${row.calculated}%`}
                    </dd>
                  </dl>
                  <ComparisonNote comparison={row.comparison} labels={labels} />
                </article>
              ))}
            </section>
          )}
          {model.materials.length > 0 && (
            <section aria-label={labels.materials}>
              <h3>{labels.materials}</h3>
              {model.materials.map((row) => (
                <article key={row.key}>
                  <h4 style={rawStyle}>{row.label}</h4>
                  <dl>
                    <dt>{labels.today}</dt>
                    <dd>
                      <CurrentValue value={row.today} labels={labels} />
                    </dd>
                    <dt>{labels.unit}</dt>
                    <dd>
                      <CurrentValue value={row.unit} labels={labels} />
                    </dd>
                    <dt>{labels.originalCumulative}</dt>
                    <dd>
                      <SourceCell
                        cell={row.original.cumulative}
                        labels={labels}
                      />
                    </dd>
                    <dt>{labels.originalPercent}</dt>
                    <dd>
                      <SourceCell cell={row.original.percent} labels={labels} />
                    </dd>
                    <dt>{labels.originalUnit}</dt>
                    <dd>
                      <SourceCell cell={row.original.unit} labels={labels} />
                    </dd>
                    <dt>{labels.originalNote}</dt>
                    <dd>
                      <SourceCell cell={row.original.note} labels={labels} />
                    </dd>
                    <dt>
                      {row.complete
                        ? labels.systemCumulative
                        : labels.partialSystemCumulative}
                    </dt>
                    <dd>
                      <CurrentValue value={row.calculated} labels={labels} />
                    </dd>
                  </dl>
                  <ComparisonNote comparison={row.comparison} labels={labels} />
                </article>
              ))}
            </section>
          )}
        </>
      )}
    </section>
  );
}
