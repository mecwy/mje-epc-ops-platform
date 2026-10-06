import { useState, type ReactNode } from 'react';
import type { PhotoAsOfDto, ReportItemDto, SourceCell } from '@mje/contracts';
import { ROLE_GROUP, ROLE_KEYS, dec, decText, pct } from '@mje/domain/rules';
import type {
  DayView,
  IssueAsOf,
  ReportContent,
  RevisionMeta,
} from '../api.js';
import {
  PersonnelMetrics,
  type PersonnelMetricsLabels,
  type PersonnelRevisionLink,
} from './PersonnelMetrics.js';
import type { PersonnelMetricsSession } from './personnel-metrics-session.js';
import { useI18n } from '../i18n.js';
import { Icon } from '../icons.js';
import { narrativeText } from '@mje/ui';
import { Chip, Kv } from '../ui.js';
import { fmtNum, fmtTime, shown } from './format.js';
import { activeWork, byKind, photoPlacement, target } from './model.js';
import { Attention, IssueList } from './Issues.js';
import { PhotoStrip, ReportPhotos } from './Photos.js';
import { FrozenWeatherReferences } from './WeatherLocation.js';
import {
  SourceReport,
  SourceCell as SourceValue,
  SourceReferences,
  type SourceReportLabels,
} from './SourceReport.js';
import {
  sourceReportModel,
  sourceCellDisplay,
  type ReportedCellDisplay,
} from './source-report.js';

function usePersonnelLabels(
  title: 'personnelCurrentTitle' | 'personnelFrozenTitle',
): PersonnelMetricsLabels {
  const { t, label } = useI18n();
  return {
    title: t(title),
    description: t('personnelDescription'),
    cumulativeTitle: t('personnelShowSevenDayCounts'),
    detailsTitle: t('personnelDetailsAndBasis'),
    shortSubtotal: t('personnelCompactSubtotal'),
    shortTotalStates: {
      complete: t('personnelCompactComplete'),
      partial: t('personnelCompactPartial'),
      unknown: t('unknown'),
      na: t('na'),
      missing: t('personnelCompactMissing'),
    },
    category: t('category'),
    knownSubtotal: t('personnelKnownSubtotal'),
    coverageTitle: t('personnelCoverageTitle'),
    contributions: t('personnelContributions'),
    state: t('personnelState'),
    noValue: t('personnelNoValue'),
    loading: t('loading'),
    refreshError: t('loadFail'),
    retry: t('retry'),
    historicalUnavailable: t('personnelUnavailable'),
    categories: Object.fromEntries(
      ROLE_KEYS.map((key) => [key, label(`role_${key}`)]),
    ) as PersonnelMetricsLabels['categories'],
    cellStates: {
      value: t('personnelValue'),
      blank: t('notFilled'),
      unknown: t('unknown'),
      na: t('na'),
      invalid: t('personnelInvalid'),
      missing: t('personnelMissing'),
    },
    totalStates: {
      complete: t('personnelComplete'),
      partial: t('personnelPartial'),
      unknown: t('unknown'),
      na: t('na'),
      missing: t('personnelMissing'),
    },
    period: (from, to) => t('personnelPeriod', { from, to }),
    coverage: (reported, slots) => t('personnelCoverage', { reported, slots }),
    categoryCoverage: (value) =>
      t('personnelCategoryCoverage', {
        value: value.valueDays,
        blank: value.blankDays,
        unknown: value.unknownDays,
        na: value.notApplicableDays,
        invalid: value.invalidDays,
        missing: value.missingFieldDays,
        unreported: value.unreportedDays,
      }),
    selectedAt: (utc) => t('personnelSelectedAt', { utc }),
    openRevision: (date, n) => t('personnelOpenRevision', { date, n }),
  };
}

/** Resolve every value and citation from the selected content, including old revisions. */
function OriginalComparison({ c }: { c: ReportContent }) {
  const { label } = useI18n();
  const source = c.facts.sourceReport;
  const cell = (value: SourceCell): ReportedCellDisplay => {
    const document = source?.documents[value.at.document];
    const { table, row, cell, gridSpan, verticalMerge } = value.at;
    return {
      raw: value.raw,
      state: value.state,
      citation: document
        ? {
            ...document,
            table,
            row,
            cell,
            ...(gridSpan !== undefined ? { gridSpan } : {}),
            ...(verticalMerge !== undefined ? { verticalMerge } : {}),
          }
        : null,
    };
  };
  const model = sourceReportModel({
    ...(source
      ? {
          source: {
            ...(source.schemaVersion !== 1 && source.reportedNextPlan
              ? {
                  reportedNextPlan: {
                    targetBusinessDate:
                      source.reportedNextPlan.targetBusinessDate,
                    quantities: Object.fromEntries(
                      Object.entries(source.reportedNextPlan.quantities).map(
                        ([key, value]) => [key, cell(value)],
                      ),
                    ),
                  },
                }
              : {}),
            ...('milestones' in source && source.milestones
              ? {
                  milestones: Object.fromEntries(
                    Object.entries(source.milestones).map(([key, row]) => [
                      key,
                      Object.fromEntries(
                        Object.entries(row).map(([field, value]) => [
                          field,
                          cell(value),
                        ]),
                      ),
                    ]),
                  ),
                }
              : {}),
            ...(source.peopleTotal
              ? { peopleTotal: cell(source.peopleTotal) }
              : {}),
            workPercent: Object.fromEntries(
              Object.entries(source.workPercent).map(([key, value]) => [
                key,
                cell(value),
              ]),
            ),
            materials: Object.fromEntries(
              Object.entries(source.materials).map(([key, value]) => [
                key,
                Object.fromEntries(
                  Object.entries(value).map(([field, value]) => [
                    field,
                    cell(value),
                  ]),
                ),
              ]),
            ),
          },
        }
      : {}),
    milestones: byKind(c.items, 'milestone').map((item) => ({
      key: item.key,
      label: label(item.label),
    })),
    people: c.facts.people,
    work: byKind(c.items, 'work').map((item) => ({
      key: item.key,
      label: label(item.label),
      unit: label(item.unit),
      cumulative: c.facts.cumulative[item.key],
      design: item.designQty,
    })),
    materials: byKind(c.items, 'material').map((item) => ({
      key: item.key,
      label: label(item.label),
      unit: item.unit,
      today: c.facts.materials[item.key],
      cumulative: c.materialsCumulative?.[item.key] ?? {
        value: null,
        complete: false,
      },
    })),
  });
  const labels = useSourceLabels();
  return <SourceReport model={model} labels={labels} />;
}

function useSourceLabels(): SourceReportLabels {
  const { t } = useI18n();
  const labels: SourceReportLabels = {
    milestones: t('sourceMilestones'),
    milestonesMissing: t('sourceMilestonesMissing'),
    plannedFinish: t('sourcePlannedFinish'),
    actualFinish: t('sourceActualFinish'),
    reportedDelayDays: t('sourceReportedDelayDays'),
    nextPlan: t('sourceNextPlan'),
    nextPlanMissing: t('sourceNextPlanMissing'),
    targetDate: t('sourceTargetDate'),
    targetQuantity: t('sourceTargetQuantity'),
    approvalUnknown: t('sourceApprovalUnknown'),
    title: t('sourceTitle'),
    missingVersion: t('sourceMissingVersion'),
    unverifiedSource: t('sourceUnverified'),
    sourceUnavailable: t('sourceUnavailable'),
    original: t('sourceOriginal'),
    blank: t('notFilled'),
    unknown: t('unknown'),
    na: t('na'),
    absent: t('sourceAbsent'),
    people: t('people'),
    classifiedTotal: t('sourceClassifiedTotal'),
    partialClassifiedTotal: t('sourcePartialClassifiedTotal'),
    workPercent: t('sourceWorkPercent'),
    calculatedPercent: t('sourceCalculatedPercent'),
    materials: t('materials'),
    today: t('sourceToday'),
    originalCumulative: t('sourceOriginalCumulative'),
    originalPercent: t('sourceOriginalPercent'),
    originalUnit: t('sourceOriginalUnit'),
    originalNote: t('sourceOriginalNote'),
    systemCumulative: t('sourceSystemCumulative'),
    partialSystemCumulative: t('sourcePartialSystemCumulative'),
    unit: t('sourceSystemUnit'),
    equal: t('sourceEqual'),
    unavailable: t('sourceCannotCompare'),
    partial: t('sourcePartial'),
    unitMismatch: t('sourceUnitMismatch'),
    unitUnavailable: t('sourceUnitUnavailable'),
    difference: (value) => t('sourceDifference', { value }),
    coordinates: (table, row, cell) =>
      t('sourceCoordinates', { table, row, cell }),
    gridSpan: (value) => t('sourceGridSpan', { value }),
    verticalMerge: (value) =>
      value === 'restart' ? t('sourceMergeRestart') : t('sourceMergeContinue'),
  };
  return labels;
}

function Val({ raw }: { raw: string | undefined }) {
  const { t, locale } = useI18n();
  const s = shown(raw, locale);
  if (s.kind === 'blank') return <span className="miss">{t('notFilled')}</span>;
  if (s.kind === 'token') return <span>{t(s.token)}</span>;
  if (s.kind === 'invalid') return <span className="miss">{s.raw}</span>;
  return <b className="num">{s.text}</b>;
}
const unitOf = (label: (s: string) => string, it?: ReportItemDto) =>
  it?.unit ? label(`u_${it.unit}`).replace(/^u_/, '') : '';

function Progress({
  c,
  photos,
  photoOnly,
}: {
  c: ReportContent;
  photos: PhotoAsOfDto[];
  /** Work items with photos but no plan or quantity: shown for their photos. */
  photoOnly: ReportItemDto[];
}) {
  const { t, label, locale } = useI18n();
  const f = c.facts;
  const sourceLabels = useSourceLabels();
  const source = f.sourceReport;
  const reportedPlan =
    source && source.schemaVersion !== 1 ? source.reportedNextPlan : undefined;
  const reportedTargets = Object.entries(reportedPlan?.quantities ?? {}).filter(
    ([, cell]) => cell.state !== 'blank',
  );

  const { active } = activeWork(c);
  const items = byKind(c.items, 'work');
  const tomorrow =
    c.nextPlan.status === 'none'
      ? []
      : c.nextPlan.rows.filter((r) => r.target !== '');
  return (
    <section className="card">
      <h2 className="blk">{t('progress')}</h2>
      {active.length === 0 && <p className="miss">{t('notFilled')}</p>}
      {active.map((it, n) => {
        const q = f.qty[it.key];
        const b = target(c, it.key);
        const p = pct(dec(q), dec(b));
        const cum = f.cumulative[it.key];
        const cp = pct(dec(cum), dec(it.designQty));
        return (
          <div key={it.key} className={`prog${n === 0 ? ' lead' : ''}`}>
            <div className="prog-top">
              <span className="prog-name">{label(it.label)}</span>
              <span className="prog-val">
                <Val raw={q} />
                {b && (
                  <span className="muted">
                    {' '}
                    / {t('baselineN', { n: fmtNum(b, locale) })}
                  </span>
                )}{' '}
                <span className="muted">{unitOf(label, it)}</span>
              </span>
              {p && <span className="pct">{p}%</span>}
            </div>
            {p && (
              <div className="bar-track">
                <div
                  className="bar-fill"
                  style={{ width: `${Math.min(100, Number(p))}%` }}
                />
              </div>
            )}
            {cum && (
              <div className="muted small">
                {t('cumulative')} {fmtNum(cum, locale)}
                {it.designQty ? ` / ${fmtNum(it.designQty, locale)}` : ''}
                {cp ? ` · ${t('sourceCalculatedPercent')} ${cp}%` : ''}
                {source?.workPercent[it.key] && (
                  <span className="report-muted">
                    {t('sourceWorkPercent')}:{' '}
                    <SourceValue
                      cell={sourceCellDisplay(
                        source,
                        source.workPercent[it.key],
                      )}
                      labels={sourceLabels}
                    />
                  </span>
                )}
              </div>
            )}
            <ReportPhotos photos={photos} type="item" id={it.key} />
          </div>
        );
      })}
      {photoOnly.map((it) => (
        <div key={it.key} className="prog">
          <div className="prog-top">
            <span className="prog-name">{label(it.label)}</span>
          </div>
          <ReportPhotos photos={photos} type="item" id={it.key} />
        </div>
      ))}
      <p className="para">
        {f.narrative.construction.trim() || (
          <span className="miss">
            {t('construction')} · {t('notFilled')}
          </span>
        )}
      </p>
      <Kv label={t('tomorrowPlan')} top>
        {tomorrow.length ? (
          tomorrow
            .map((r) => {
              const it = items.find((i) => i.key === r.item);
              return `${it ? label(it.label) : r.item} ${fmtNum(r.target, locale)} ${unitOf(label, it)}`;
            })
            .join(' · ')
        ) : (
          <span className="miss">{t('notPlanned')}</span>
        )}{' '}
        {c.nextPlan.status === 'confirmed' && (
          <Chip tone="ok">{t('confirmedN', { n: c.nextPlan.n ?? 0 })}</Chip>
        )}
        {c.nextPlan.status === 'draft' && <Chip>{t('draft')}</Chip>}
      </Kv>
      <Kv label={t('sourceNextPlan')} top>
        {reportedPlan ? (
          <>
            <time dateTime={reportedPlan.targetBusinessDate}>
              {reportedPlan.targetBusinessDate}
            </time>
            {reportedTargets.length ? (
              reportedTargets.map(([key, value]) => {
                const item = items.find((it) => it.key === key);
                return (
                  <div key={key}>
                    {item ? label(item.label) : key}{' '}
                    <SourceValue
                      cell={sourceCellDisplay(source, value)}
                      labels={sourceLabels}
                    />{' '}
                    {unitOf(label, item)}
                  </div>
                );
              })
            ) : (
              <span className="report-muted">{t('notFilled')}</span>
            )}
            <small className="report-muted">{t('sourceApprovalUnknown')}</small>
          </>
        ) : (
          <span className="report-muted">{t('sourceNextPlanMissing')}</span>
        )}
      </Kv>
    </section>
  );
}

function Resources({ c }: { c: ReportContent }) {
  const { t, label, locale } = useI18n();
  const f = c.facts;
  const sourceLabels = useSourceLabels();
  const source = f.sourceReport;
  const originalTotal = sourceCellDisplay(source, source?.peopleTotal);
  const peopleComparison = sourceReportModel({
    ...(source
      ? {
          source: {
            ...(originalTotal ? { peopleTotal: originalTotal } : {}),
            workPercent: {},
            materials: {},
          },
        }
      : {}),
    people: f.people,
    work: [],
    materials: [],
  }).people;

  const numeric = ROLE_KEYS.filter((r) => dec(f.people[r]) !== null);
  const roles = ROLE_KEYS.map((r) => (f.people[r] ?? '').trim());
  // A total is complete only when every role is a number or n/a; otherwise say it is partial.
  const partial = ROLE_KEYS.some(
    (r) => dec(f.people[r]) === null && f.people[r] !== 'na',
  );
  const sum = (groups: string[]) =>
    ROLE_KEYS.filter((r) => groups.includes(ROLE_GROUP[r])).reduce(
      (a, r) => a + (dec(f.people[r]) ?? 0n),
      0n,
    );
  const machinery = byKind(c.items, 'machinery');
  const materials = byKind(c.items, 'material');
  const value = (m: ReportItemDto) => (f.materials[m.key] ?? '').trim();
  const blank = materials.filter((m) => value(m) === '').length;
  const unknown = materials.filter((m) => value(m) === 'unknown').length;
  const arrived = materials.filter((m) => (dec(value(m)) ?? 0n) > 0n);
  // "No deliveries" only when every material is an explicit zero or n/a.
  const noneArrived = materials.every(
    (m) => value(m) === 'na' || dec(value(m)) === 0n,
  );
  return (
    <section className="card">
      <h2 className="blk">{t('resources')}</h2>
      <Kv
        label={
          partial
            ? t('sourcePartialClassifiedTotal')
            : t('sourceClassifiedTotal')
        }
      >
        {numeric.length ? (
          <>
            <b className="num">{decText(sum(['gc', 'sub', 'worker']))}</b>{' '}
            {t('persons')} · {t('mgmtN', { n: decText(sum(['gc', 'sub'])) })} ·{' '}
            {t('installN', { n: decText(sum(['worker'])) })}
            {partial && <span className="miss"> · {t('incomplete')}</span>}
          </>
        ) : roles.every((r) => r === '') ? (
          <span className="miss">{t('notFilled')}</span>
        ) : roles.every((r) => r === 'na') ? (
          t('na')
        ) : (
          <span className="miss">
            {t('unknown')}
            {roles.some((r) => r === '') &&
              ` · ${t('nBlank', { n: roles.filter((r) => r === '').length })}`}
          </span>
        )}
      </Kv>
      <Kv label={`${t('people')} · ${t('sourceOriginal')}`}>
        <SourceValue cell={originalTotal} labels={sourceLabels} />
        {peopleComparison.comparison.state === 'different' && (
          <small className="report-muted">
            {t('sourceDifference', {
              value: peopleComparison.comparison.difference,
            })}
          </small>
        )}
        {peopleComparison.comparison.state === 'equal' && (
          <small className="report-muted">{t('sourceEqual')}</small>
        )}
        {peopleComparison.comparison.state === 'partial' && (
          <small className="report-muted">{t('sourcePartial')}</small>
        )}
      </Kv>
      {machinery.length > 0 && (
        <Kv label={t('machinery')}>
          {machinery.map((m, i) => (
            <span key={m.key}>
              {i > 0 && ' · '}
              {label(m.label)}{' '}
              {f.machinery[m.key] === '0' ? (
                t('unused')
              ) : (
                <Val raw={f.machinery[m.key]} />
              )}
            </span>
          ))}
        </Kv>
      )}
      {materials.length > 0 && (
        <Kv label={t('materials')}>
          {blank === materials.length ? (
            <span className="miss">{t('notFilled')}</span>
          ) : (
            <>
              {arrived.length > 0 &&
                arrived
                  .map(
                    (m) =>
                      `${label(m.label)} +${fmtNum(value(m), locale)} ${unitOf(label, m)}`,
                  )
                  .join(' · ')}
              {noneArrived && t('noArrival')}
              {unknown > 0 && (
                <span className="miss">
                  {arrived.length ? ' · ' : ''}
                  {t('unknown')} {unknown}
                </span>
              )}
              {blank > 0 && (
                <span className="miss">
                  {arrived.length || unknown ? ' · ' : ''}
                  {t('nBlank', { n: blank })}
                </span>
              )}
            </>
          )}
        </Kv>
      )}
    </section>
  );
}

function Issues({
  c,
  photos,
  otherIssues,
}: {
  c: ReportContent;
  photos: PhotoAsOfDto[];
  otherIssues: IssueAsOf[];
}) {
  const { t, lang } = useI18n();
  const n = c.facts.narrative;
  const quality = narrativeText(n.quality, lang);
  const safety = narrativeText(n.safety, lang);
  return (
    <section className="card">
      <div className="blk-row">
        <h2 className="blk">{t('issues')}</h2>
      </div>
      <IssueList
        issues={c.issues ?? []}
        photos={photos}
        withPhotos={otherIssues}
      />
      <Kv label={t('quality')}>
        {quality.trim() || <span className="miss">{t('notFilled')}</span>}
      </Kv>
      <Kv label={t('safety')}>
        {safety.trim() || <span className="miss">{t('notFilled')}</span>}
      </Kv>
    </section>
  );
}

function BusinessSections({
  c,
  photos,
  photoOnly,
  personnel,
}: {
  personnel: ReactNode;
  c: ReportContent;
  photos: PhotoAsOfDto[];
  photoOnly: ReportItemDto[];
}) {
  const { t, label, locale } = useI18n();
  const source = c.facts.sourceReport;
  const extra =
    source?.schemaVersion === 4 || source?.schemaVersion === 5
      ? source
      : undefined;
  const workAreas = source?.schemaVersion === 5 ? source.workAreas : undefined;
  const workRows = c.items.filter(
    (item) => item.kind === 'work' && (item.active || workAreas?.[item.key]),
  );
  // Retiring an entry must not hide cells already captured in this report version.
  const machineryRows = c.items.filter(
    (item) =>
      item.kind === 'machinery' &&
      (item.active || extra?.machinery?.[item.key]),
  );
  const sourceLabels = useSourceLabels();
  const raw = (value: SourceCell | undefined) => (
    <SourceValue
      cell={sourceCellDisplay(source, value)}
      labels={sourceLabels}
    />
  );
  const [selected, setSelected] = useState<
    'progress' | 'materials' | 'people' | 'machinery'
  >('progress');
  const table = (heads: string[], rows: ReactNode[][]) => (
    <div className="report-table-scroll" tabIndex={0}>
      <table>
        <thead>
          <tr>
            {heads.map((head, i) => (
              <th key={i} scope="col">
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, n) =>
                n === 0 ? (
                  <th key={n} scope="row">
                    {cell}
                  </th>
                ) : (
                  <td key={n}>{cell}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <section className="card report-business">
      <div
        className="report-section-tabs"
        role="group"
        aria-label={t('allDetails')}
      >
        {(['progress', 'materials', 'people', 'machinery'] as const).map(
          (key) => (
            <button
              key={key}
              type="button"
              aria-pressed={selected === key}
              onClick={() => setSelected(key)}
            >
              {t(key)}
            </button>
          ),
        )}
      </div>
      <div hidden={selected !== 'progress'} className="report-business-panel">
        <Progress c={c} photos={photos} photoOnly={photoOnly} />
        {table(
          [
            t('progress'),
            ...(workAreas ? [t('sourceReportedArea')] : []),
            t('today'),
            `${t('cumulative')} · ${t('sourceCalculatedPercent')}`,
            t('design'),
          ],
          workRows.map((it) => {
            const completion = pct(
              dec(c.facts.cumulative[it.key]),
              dec(it.designQty),
            );
            return [
              label(it.label),
              ...(workAreas ? [raw(workAreas[it.key])] : []),
              <Val key="qty" raw={c.facts.qty[it.key]} />,
              <span key="cum" className="report-completion">
                <Val raw={c.facts.cumulative[it.key]} />
                {completion !== null && (
                  <>
                    <span className="report-muted">{completion}%</span>
                    <span className="bar-track">
                      <span
                        className="bar-fill"
                        style={{
                          width: `${Math.min(100, Number(completion))}%`,
                        }}
                      />
                    </span>
                  </>
                )}
              </span>,
              `${fmtNum(it.designQty, locale)} ${unitOf(label, it)}`,
            ];
          }),
        )}
        {workAreas && (
          <>
            <p className="report-muted">{t('sourceAreaUnconfirmed')}</p>
            <SourceReferences
              labels={sourceLabels}
              rows={workRows.map((it) => ({
                label: `${label(it.label)} · ${t('sourceReportedArea')}`,
                cells: [sourceCellDisplay(source, workAreas[it.key])],
              }))}
            />
          </>
        )}
      </div>
      <div hidden={selected !== 'materials'} className="report-business-panel">
        {table(
          [
            t('materials'),
            t('sourceToday'),
            t('sourceSystemUnit'),
            t('sourceSystemCumulative'),
            t('sourceOriginalCumulative'),
            t('sourceOriginalPercent'),
          ],
          byKind(c.items, 'material').map((it) => [
            label(it.label),
            <Val key="today" raw={c.facts.materials[it.key]} />,
            unitOf(label, it),
            <span key="cum">
              {c.materialsCumulative?.[it.key]?.value == null ? (
                t('unknown')
              ) : (
                <Val
                  raw={c.materialsCumulative?.[it.key]?.value ?? undefined}
                />
              )}
              {!c.materialsCumulative?.[it.key]?.complete && (
                <small className="report-muted">
                  {t('sourcePartialSystemCumulative')}
                </small>
              )}
            </span>,
            raw(source?.materials[it.key]?.cumulative),
            raw(source?.materials[it.key]?.percent),
          ]),
        )}
      </div>
      <div hidden={selected !== 'people'} className="report-business-panel">
        {personnel}
        {table(
          [t('people'), t('persons'), t('sourcePersonnelRemarks')],
          ROLE_KEYS.map((key) => [
            label(`role_${key}`),
            <Val key={key} raw={c.facts.people[key]} />,
            raw(extra?.personnelRemarks?.[key]),
          ]),
        )}
        {extra?.personnelRemarks && (
          <SourceReferences
            labels={sourceLabels}
            rows={ROLE_KEYS.map((key) => ({
              label: label(`role_${key}`),
              cells: [sourceCellDisplay(source, extra.personnelRemarks?.[key])],
            }))}
          />
        )}
      </div>
      <div hidden={selected !== 'machinery'} className="report-business-panel">
        {table(
          [
            t('machinery'),
            t('today'),
            t('sourceLocation'),
            t('sourceOriginalNote'),
          ],
          machineryRows.map((it) => [
            label(it.label),
            <Val key={it.key} raw={c.facts.machinery[it.key]} />,
            raw(extra?.machinery?.[it.key]?.location),
            raw(extra?.machinery?.[it.key]?.note),
          ]),
        )}
        {extra?.machinery && (
          <SourceReferences
            labels={sourceLabels}
            rows={machineryRows.map((it) => ({
              label: label(it.label),
              cells: [
                sourceCellDisplay(source, extra.machinery?.[it.key]?.location),
                sourceCellDisplay(source, extra.machinery?.[it.key]?.note),
              ],
            }))}
          />
        )}
      </div>
    </section>
  );
}

/** No-work reports still retain source declarations; these rows are never operational totals. */
function NoWorkSources({ c }: { c: ReportContent }) {
  const { t, label } = useI18n();
  const labels = useSourceLabels();
  const source = c.facts.sourceReport;
  if (!source || (source.schemaVersion !== 4 && source.schemaVersion !== 5))
    return null;
  const itemLabel = (kind: ReportItemDto['kind'], key: string) =>
    label(
      c.items.find((item) => item.kind === kind && item.key === key)?.label ??
        key,
    );
  const areas = source.schemaVersion === 5 ? source.workAreas : undefined;
  const rows: { label: string; value: SourceCell }[] = [
    ...Object.entries(areas ?? {}).map(([key, value]) => ({
      label: `${t('sourceReportedArea')} · ${itemLabel('work', key)}`,
      value,
    })),
    ...Object.entries(source.machinery ?? {}).flatMap(([key, fields]) =>
      (['location', 'note'] as const).flatMap((field) => {
        const value = fields[field];
        return value
          ? [
              {
                label: `${t('machinery')} · ${itemLabel('machinery', key)} · ${field === 'location' ? t('sourceLocation') : t('sourceOriginalNote')}`,
                value,
              },
            ]
          : [];
      }),
    ),
    ...Object.entries(source.personnelRemarks ?? {}).map(([key, value]) => ({
      label: `${t('people')} · ${label(`role_${key}`)} · ${t('sourceOriginalNote')}`,
      value,
    })),
  ];
  if (!rows.length) return null;
  return (
    <section
      className="card report-no-work-source"
      aria-label={t('sourceUnverified')}
    >
      <h2>{t('sourceUnverified')}</h2>
      {rows.map((row, index) => (
        <div key={index}>
          <strong>{row.label}: </strong>
          <SourceValue
            cell={sourceCellDisplay(source, row.value)}
            labels={labels}
          />
        </div>
      ))}
      {areas && <p className="report-muted">{t('sourceAreaUnconfirmed')}</p>}
      <SourceReferences
        labels={labels}
        rows={rows.map((row) => ({
          label: row.label,
          cells: [sourceCellDisplay(source, row.value)],
        }))}
      />
    </section>
  );
}

function OriginalDuration({ c }: { c: ReportContent }) {
  const { t } = useI18n();
  const labels = useSourceLabels();
  const source = c.facts.sourceReport;
  const duration =
    source?.schemaVersion === 5 ? source.reportedDuration : undefined;
  if (!duration) return null;
  const rows = [
    { label: t('sourceContractDuration'), value: duration.contract },
    { label: t('sourceElapsedDuration'), value: duration.elapsed },
  ].filter((row) => row.value !== undefined);
  return (
    <section
      className="card report-duration"
      aria-label={t('sourceReportedDuration')}
    >
      <h2>{t('sourceReportedDuration')}</h2>
      {rows.map((row) => (
        <div key={row.label}>
          <strong>{row.label}</strong>
          <SourceValue
            cell={sourceCellDisplay(source, row.value)}
            labels={labels}
          />
        </div>
      ))}
      <p className="report-muted">{t('sourceDurationNotPlan')}</p>
      <SourceReferences
        labels={labels}
        rows={rows.map((row) => ({
          label: row.label,
          cells: [sourceCellDisplay(source, row.value)],
        }))}
      />
    </section>
  );
}

function OriginalRecorder({ c }: { c: ReportContent }) {
  const { t } = useI18n();
  const labels = useSourceLabels();
  const source = c.facts.sourceReport;
  const recorder =
    source?.schemaVersion === 4 || source?.schemaVersion === 5
      ? source.reportedRecorder
      : undefined;
  if (!recorder) return null;
  const cell = sourceCellDisplay(source, recorder.line);
  return (
    <section className="card report-recorder" aria-label={t('sourceRecorder')}>
      <strong>{t('sourceRecorder')}</strong>
      <SourceValue cell={cell} labels={labels} />
      {recorder.nameState === 'blank' && (
        <small>{t('sourceRecorderBlank')}</small>
      )}
      {recorder.nameState === 'unknown' && <small>{t('unknown')}</small>}
      <small className="report-muted">{t('sourceRecorderNotIdentity')}</small>
      <SourceReferences
        labels={labels}
        rows={[{ label: t('sourceRecorder'), cells: [cell] }]}
      />
    </section>
  );
}

function Details({ c }: { c: ReportContent }) {
  const { t, label, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const f = c.facts;
  return (
    <>
      <button
        type="button"
        className="linkrow"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="grow">{t('allDetails')}</span>
        {open ? <Icon.down /> : <Icon.right />}
      </button>
      {open && (
        <section className="card details">
          <h3>{t('progress')}</h3>
          <table>
            <thead>
              <tr>
                <th />
                <th>{t('today')}</th>
                <th>{t('cumulative')}</th>
                <th>{t('design')}</th>
              </tr>
            </thead>
            <tbody>
              {byKind(c.items, 'work').map((it) => (
                <tr key={it.key}>
                  <td>{label(it.label)}</td>
                  <td>
                    <Val raw={f.qty[it.key]} />
                  </td>
                  <td>
                    {f.cumulative[it.key]
                      ? fmtNum(f.cumulative[it.key], locale)
                      : '—'}
                  </td>
                  <td>
                    {fmtNum(it.designQty, locale)} {unitOf(label, it)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>{t('materials')}</h3>
          <table>
            <thead>
              <tr>
                <th />
                <th>{t('today')}</th>
                <th>{t('cumulative')}</th>
                <th>{t('design')}</th>
              </tr>
            </thead>
            <tbody>
              {byKind(c.items, 'material').map((m) => {
                const total = c.materialsCumulative?.[m.key];
                return (
                  <tr key={m.key}>
                    <td>{label(m.label)}</td>
                    <td>
                      <Val raw={f.materials[m.key]} />
                    </td>
                    <td>
                      {total?.value ? fmtNum(total.value, locale) : '—'}
                      {total && !total.complete && (
                        <span className="miss"> · {t('incomplete')}</span>
                      )}
                    </td>
                    <td>
                      {fmtNum(m.designQty, locale)} {unitOf(label, m)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

export function ReportBody({
  personnelSession,
  onOpenPersonnelRevision,
  c,
  version,
  timeZone,
  onReply,
  photos,
}: {
  personnelSession?: PersonnelMetricsSession;
  onOpenPersonnelRevision?: (target: PersonnelRevisionLink) => void;
  c: ReportContent;
  version: RevisionMeta | null;
  timeZone: string;
  onReply?: ((issueId: string) => void) | null;
  /** Shown under their work items and issues (a submitted day: as frozen). */
  photos: PhotoAsOfDto[];
}) {
  const { t, locale, label } = useI18n();
  const currentLabels = usePersonnelLabels('personnelCurrentTitle');
  const frozenLabels = usePersonnelLabels('personnelFrozenTitle');
  const personnel = onOpenPersonnelRevision ? (
    <div className="personnel-metrics">
      {version && (
        <PersonnelMetrics
          mode="frozen"
          summary={c.personnelSummary ?? null}
          labels={frozenLabels}
          onOpenRevision={onOpenPersonnelRevision}
        />
      )}
      {personnelSession && (
        <PersonnelMetrics
          mode="current"
          session={personnelSession}
          labels={currentLabels}
          onOpenRevision={onOpenPersonnelRevision}
        />
      )}
    </div>
  ) : null;
  const f = c.facts;
  const weather = [f.weather, f.temperature].filter(Boolean).join(' · ');
  const placed = photoPlacement(c, photos);
  return (
    <div className="report-redesign">
      {(version || weather) && (
        <div className="status-row">
          {version && (
            <Chip tone="ok">
              {t('submittedAt', { t: fmtTime(version.at, locale, timeZone) })}
            </Chip>
          )}
          {version && version.n > 1 && (
            <Chip tone="warn">{t('corrected', { n: version.n })}</Chip>
          )}
        </div>
      )}
      <OriginalDuration c={c} />
      {weather && (
        <section className="card report-weather" aria-label={t('weather')}>
          <div>
            <span className="report-eyebrow">{t('temperature')}</span>
            <strong>{f.temperature || t('notFilled')}</strong>
          </div>
          <div>
            <span className="report-eyebrow">{t('weather')}</span>
            <p>{f.weather || t('notFilled')}</p>
          </div>
        </section>
      )}
      <Attention issues={c.issues ?? []} onReply={onReply ?? null} />
      <FrozenWeatherReferences references={c.weatherReferences ?? []} />
      {f.reportLocationRef && (
        <section
          className="card report-weather"
          aria-label={t('weatherLocation_savedLocation')}
        >
          <h3>{t('weatherLocation_savedLocation')}</h3>
          <p>
            {t('weatherLocation_accuracy')}: {f.reportLocationRef.accuracyM} m
          </p>
          <p>
            {t('weatherLocation_device')}:{' '}
            {f.reportLocationRef.deviceFixAt ?? t('unknown')}
          </p>
          <p>
            {t('weatherLocation_acquired')}: {f.reportLocationRef.acquiredAt}
          </p>
        </section>
      )}
      <div className="rgrid">
        <div className="rcol">
          {f.noWork ? (
            <section className="card">
              <h2 className="blk">{t('progress')}</h2>
              <p className="big">{t('noWork')}</p>
              <p>
                {label(`nw_${f.noWork.reason}`)}
                {f.noWork.note ? ` · ${f.noWork.note}` : ''}
              </p>
            </section>
          ) : (
            <BusinessSections
              c={c}
              photos={photos}
              photoOnly={placed.photoOnlyItems}
              personnel={personnel}
            />
          )}
          {f.noWork && personnel}
          {f.noWork && <NoWorkSources c={c} />}
        </div>
        <div className="rcol">
          {!f.noWork && <Resources c={c} />}
          <Issues c={c} photos={photos} otherIssues={placed.otherIssues} />
          {placed.unplaced.length > 0 && (
            <section className="card">
              <h2 className="blk">{t('photos')}</h2>
              <PhotoStrip photos={placed.unplaced} />
            </section>
          )}
        </div>
      </div>
      <Details c={c} />
      <OriginalRecorder c={c} />
      <OriginalComparison c={c} />
    </div>
  );
}

/** The report tab: frozen revision when submitted, live content otherwise. */
export function ReportView({
  personnelSession,
  onOpenPersonnelRevision,
  day,
  read,
  canWrite,
  missing,
  onFill,
  onNoWork,
  onReply,
  photos,
}: {
  personnelSession: PersonnelMetricsSession;
  onOpenPersonnelRevision: (target: PersonnelRevisionLink) => void;
  day: DayView;
  read: ReportContent;
  canWrite: boolean;
  missing: number;
  onFill: () => void;
  onNoWork: () => void;
  onReply: ((issueId: string) => void) | null;
  photos: PhotoAsOfDto[];
}) {
  const { t } = useI18n();
  if (day.state === 'submitted')
    return (
      <ReportBody
        c={read}
        personnelSession={personnelSession}
        onOpenPersonnelRevision={onOpenPersonnelRevision}
        version={day.revisions.at(-1) ?? null}
        onReply={onReply}
        timeZone={day.siteTimezone}
        photos={photos}
      />
    );
  // Readers see a day once it is submitted; a draft being written is not a report yet.
  if (!canWrite)
    return (
      <section className="card empty">
        <h2>{t('notSubmitted')}</h2>
      </section>
    );
  if (day.state === 'empty')
    return (
      <section className="card empty">
        <h2>{t('noRecord')}</h2>
        {canWrite && (
          <div className="row2">
            <button type="button" className="primary" onClick={onFill}>
              {t('startFill')}
            </button>
            <button type="button" className="ghost" onClick={onNoWork}>
              {t('noWork')}
            </button>
          </div>
        )}
      </section>
    );
  return (
    <>
      {canWrite && (
        <section className="card due">
          {day.state === 'correcting' ? (
            <>
              <div className="due-row">
                <Chip tone="warn">{t('correcting')}</Chip>
                <span className="muted">{day.correctionReason}</span>
              </div>
              <button type="button" className="primary wide" onClick={onFill}>
                {t('continueCorrect')}
              </button>
            </>
          ) : (
            <>
              <div className="due-row">
                <strong>{t('tonightDue', { n: missing })}</strong>
              </div>
              <div className="row2">
                <button type="button" className="primary" onClick={onFill}>
                  {t('continueFill')}
                </button>
                <button type="button" className="ghost" onClick={onNoWork}>
                  {t('noWork')}
                </button>
              </div>
            </>
          )}
        </section>
      )}
      <ReportBody
        c={read}
        personnelSession={personnelSession}
        onOpenPersonnelRevision={onOpenPersonnelRevision}
        version={null}
        timeZone={day.siteTimezone}
        photos={photos}
      />
    </>
  );
}
