import type { ReactNode } from 'react';
import type {
  Comparison,
  ReportedCellDisplay,
  SourceReportDisplayModel,
} from './source-report.js';

/** Every visible caption is supplied by the host's selected language. No API/i18n coupling. */
export interface SourceReportLabels {
  milestones: string;
  milestonesMissing: string;
  plannedFinish: string;
  actualFinish: string;
  reportedDelayDays: string;
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

export function SourceCell({
  cell,
  labels,
}: {
  cell: ReportedCellDisplay | undefined;
  labels: SourceReportLabels;
}) {
  if (!cell) return <span className="source-empty">{labels.absent}</span>;
  return (
    <span
      className={cell.state === 'value' ? 'source-value' : 'source-empty'}
      style={rawStyle}
    >
      {cell.state !== 'value' && (
        <span>
          {labels[cell.state]}
          {cell.raw.trim() ? ' · ' : ''}
        </span>
      )}
      <span>{cell.raw}</span>
      {cell.citation?.verticalMerge && (
        <small className="source-merge">
          {labels.verticalMerge(cell.citation.verticalMerge)}
        </small>
      )}
    </span>
  );
}
export function SourceReferences({
  rows,
  labels,
}: {
  rows: { label: string; cells: (ReportedCellDisplay | undefined)[] }[];
  labels: SourceReportLabels;
}) {
  return (
    <details className="source-references">
      <summary>{labels.unverifiedSource}</summary>
      {rows.map((row, i) => (
        <div key={i}>
          <strong>{row.label}</strong>
          {row.cells.filter(Boolean).map((cell, n) => {
            const citation = cell!.citation;
            return (
              <div key={n} className="source-reference" style={rawStyle}>
                {citation ? (
                  <>
                    <span>{citation.label}</span>
                    <code>SHA-256: {citation.sha256}</code>
                    <span>
                      {labels.coordinates(
                        citation.table,
                        citation.row,
                        citation.cell,
                      )}
                    </span>
                    {citation.gridSpan !== undefined && (
                      <span>{labels.gridSpan(citation.gridSpan)}</span>
                    )}
                    {citation.verticalMerge && (
                      <span>
                        {labels.verticalMerge(citation.verticalMerge)}
                      </span>
                    )}
                  </>
                ) : (
                  labels.sourceUnavailable
                )}
              </div>
            );
          })}
        </div>
      ))}
    </details>
  );
}
function SourceTable({
  headers,
  rows,
  label,
}: {
  headers: string[];
  rows: ReactNode[][];
  label: string;
}) {
  return (
    <div
      className="source-table-scroll"
      tabIndex={0}
      role="group"
      aria-label={label}
    >
      <table>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((value, n) =>
                n === 0 ? (
                  <th key={n} scope="row">
                    {value}
                  </th>
                ) : (
                  <td key={n}>{value}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
  const value = (cell: ReportedCellDisplay | undefined) => (
    <SourceCell cell={cell} labels={labels} />
  );
  return (
    <section className="card source-report" aria-label={labels.title}>
      <details className="source-disclosure">
        <summary>
          <span>{labels.title}</span>
          <small>{labels.unverifiedSource}</small>
        </summary>
        {!model.recorded ? (
          <p className="source-section">{labels.missingVersion}</p>
        ) : (
          <div className="source-sections">
            <section className="source-section" aria-label={labels.nextPlan}>
              <h3>{labels.nextPlan}</h3>
              {model.nextPlan ? (
                <>
                  <p className="source-context">
                    {labels.targetDate}:{' '}
                    <time dateTime={model.nextPlan.targetBusinessDate}>
                      {model.nextPlan.targetBusinessDate}
                    </time>{' '}
                    · {labels.approvalUnknown}
                  </p>
                  <SourceTable
                    label={labels.nextPlan}
                    headers={[
                      labels.nextPlan,
                      labels.targetQuantity,
                      labels.unit,
                    ]}
                    rows={model.nextPlan.rows.map((row) => [
                      row.label,
                      value(row.original),
                      row.unit || labels.unknown,
                    ])}
                  />
                  <SourceReferences
                    labels={labels}
                    rows={model.nextPlan.rows.map((row) => ({
                      label: row.label,
                      cells: [row.original],
                    }))}
                  />
                </>
              ) : (
                <p>{labels.nextPlanMissing}</p>
              )}
            </section>
            <section className="source-section" aria-label={labels.milestones}>
              <h3>{labels.milestones}</h3>
              {model.milestones ? (
                <>
                  <SourceTable
                    label={labels.milestones}
                    headers={[
                      labels.milestones,
                      labels.plannedFinish,
                      labels.actualFinish,
                      labels.reportedDelayDays,
                      labels.originalNote,
                    ]}
                    rows={model.milestones.map((row) => [
                      row.label,
                      value(row.original.plannedFinish),
                      value(row.original.actualFinish),
                      value(row.original.reportedDelayDays),
                      value(row.original.note),
                    ])}
                  />
                  <SourceReferences
                    labels={labels}
                    rows={model.milestones.map((row) => ({
                      label: row.label,
                      cells: Object.values(row.original),
                    }))}
                  />
                </>
              ) : (
                <p>{labels.milestonesMissing}</p>
              )}
            </section>
            <section className="source-section" aria-label={labels.people}>
              <h3>{labels.people}</h3>
              <SourceTable
                label={labels.people}
                headers={[
                  labels.original,
                  model.people.complete
                    ? labels.classifiedTotal
                    : labels.partialClassifiedTotal,
                ]}
                rows={[
                  [
                    value(model.people.original),
                    <CurrentValue
                      key="people"
                      value={model.people.calculated}
                      labels={labels}
                    />,
                  ],
                ]}
              />
              <ComparisonNote
                comparison={model.people.comparison}
                labels={labels}
              />
              <SourceReferences
                labels={labels}
                rows={[
                  { label: labels.people, cells: [model.people.original] },
                ]}
              />
            </section>
            {model.work.length > 0 && (
              <section
                className="source-section"
                aria-label={labels.workPercent}
              >
                <h3>{labels.workPercent}</h3>
                <SourceTable
                  label={labels.workPercent}
                  headers={[
                    labels.workPercent,
                    labels.original,
                    labels.calculatedPercent,
                    labels.title,
                  ]}
                  rows={model.work.map((row) => [
                    row.label,
                    value(row.original),
                    row.calculated === null
                      ? labels.unknown
                      : `${row.calculated}%`,
                    <ComparisonNote
                      key={row.key}
                      comparison={row.comparison}
                      labels={labels}
                    />,
                  ])}
                />
                <SourceReferences
                  labels={labels}
                  rows={model.work.map((row) => ({
                    label: row.label,
                    cells: [row.original],
                  }))}
                />
              </section>
            )}
            {model.materials.length > 0 && (
              <section className="source-section" aria-label={labels.materials}>
                <h3>{labels.materials}</h3>
                <SourceTable
                  label={labels.materials}
                  headers={[
                    labels.materials,
                    labels.today,
                    labels.unit,
                    labels.originalCumulative,
                    labels.originalPercent,
                    labels.originalUnit,
                    labels.originalNote,
                    labels.systemCumulative,
                  ]}
                  rows={model.materials.map((row) => [
                    row.label,
                    <CurrentValue
                      key="today"
                      value={row.today}
                      labels={labels}
                    />,
                    <CurrentValue
                      key="unit"
                      value={row.unit}
                      labels={labels}
                    />,
                    value(row.original.cumulative),
                    value(row.original.percent),
                    value(row.original.unit),
                    value(row.original.note),
                    <div key="system">
                      <small>
                        {row.complete
                          ? labels.systemCumulative
                          : labels.partialSystemCumulative}
                      </small>
                      <CurrentValue value={row.calculated} labels={labels} />
                      <ComparisonNote
                        comparison={row.comparison}
                        labels={labels}
                      />
                    </div>,
                  ])}
                />
                <SourceReferences
                  labels={labels}
                  rows={model.materials.map((row) => ({
                    label: row.label,
                    cells: Object.values(row.original),
                  }))}
                />
              </section>
            )}
          </div>
        )}
      </details>
    </section>
  );
}
