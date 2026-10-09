import type { ReactNode } from 'react';
import { useState } from 'react';
import type { ReportActivity, ReportItemDto } from '@mje/contracts';
import type { DayHandle } from './useDay.js';
import type { DayView } from '../api.js';
import { dec, decText } from '@mje/domain/rules';
import {
  newActivity,
  editActivity,
  pendingActivityUse,
  consumptionRows,
} from './activity-model.js';
import { PhotoLine } from './Photos.js';
import { useI18n } from '../i18n.js';
import { activityText } from './activity-card-copy.js';
import './activity-card.css';

export interface ActivityCardFields {
  id: string;
  area: string;
  scope: string;
  process: string;
  completion: string;
  quantity: string;
  outputUnit: string;
  material: string | null;
  consumption: string;
  materialUnit: string;
  consumptionState: 'estimated' | 'edited' | 'pending' | 'declared';
  explanation: string;
  reviewRequired: boolean;
}

/** Presentation only; the owning day session persists output and use together. */
export function ActivityCard({
  value,
  locked,
  onChange,
  onPending,
  photos,
  materialChoice,
  areaLocked = false,
}: {
  value: ActivityCardFields;
  locked: boolean;
  onChange: (
    field:
      | 'area'
      | 'scope'
      | 'process'
      | 'completion'
      | 'quantity'
      | 'consumption'
      | 'explanation',
    value: string,
  ) => void;
  onPending: (pending: boolean) => void;
  photos?: ReactNode;
  materialChoice?: ReactNode;
  areaLocked?: boolean;
}) {
  const { lang } = useI18n();
  const text = activityText(lang);
  const field = (
    key: 'area' | 'scope' | 'process' | 'completion',
    label: string,
  ) => (
    <label className="field">
      <span>{label}</span>
      <input
        disabled={locked || (key === 'area' && areaLocked)}
        value={value[key]}
        maxLength={500}
        onChange={(e) => onChange(key, e.target.value)}
      />
    </label>
  );
  return (
    <section
      className="activity-card"
      aria-label={`${text.process} ${value.process}`}
    >
      <fieldset className="bare" disabled={locked}>
        <div className="activity-scope">
          {field('area', text.area)}
          <p className="muted small">
            {text.package}: {value.scope}
          </p>
        </div>
        {field('process', text.process)}
        {field('completion', text.status)}
        <label className="field">
          <span>
            {text.output} · {value.outputUnit}
          </span>
          <input
            aria-label={text.output}
            inputMode="decimal"
            value={value.quantity}
            onChange={(e) => onChange('quantity', e.target.value)}
          />
        </label>
        {!value.quantity && <p className="muted small">{text.noQuantity}</p>}
        <div className="activity-use">
          <b>{value.material ?? text.material}</b>
          {materialChoice}
          <label className="field">
            <span>
              {text.actual} · {value.materialUnit}
            </span>
            <input
              aria-label={text.actual}
              inputMode="decimal"
              disabled={
                locked ||
                !value.material ||
                value.consumptionState === 'pending'
              }
              value={value.consumption}
              onChange={(e) => onChange('consumption', e.target.value)}
            />
          </label>
          <p className="small" role="status">
            {
              text[
                value.consumptionState === 'estimated'
                  ? 'estimate'
                  : value.consumptionState
              ]
            }
          </p>
          {value.reviewRequired && <p className="banner warn">{text.review}</p>}
          <label className="activity-pending">
            <input
              type="checkbox"
              checked={value.consumptionState === 'pending'}
              onChange={(e) => onPending(e.target.checked)}
            />
            {text.pending}
          </label>
          <label className="field">
            <span>{text.difference}</span>
            <input
              value={value.explanation}
              maxLength={500}
              onChange={(e) => onChange('explanation', e.target.value)}
            />
          </label>
        </div>
      </fieldset>
      {photos}
    </section>
  );
}

export function ActivityEntries({
  h,
  day,
  locked,
}: {
  h: DayHandle;
  day: DayView;
  locked: boolean;
}) {
  const { lang, label } = useI18n();
  const text = activityText(lang);
  const work = day.items.filter((i) => i.kind === 'work' && i.active);
  const materials = day.items.filter((i) => i.kind === 'material' && i.active);
  const [selected, setSelected] = useState('');
  const [kind, setKind] =
    useState<ReportActivity['outputKind']>('installation');
  const rows = h.facts?.activities ?? [];
  const supported = Object.hasOwn(day, 'activityMappings') || rows.length > 0;
  const chosen = work.find((i) => i.key === selected) ?? work[0];
  const write = (next: ReportActivity[]) =>
    h.edit('activities', JSON.stringify(next));
  const update = (id: string, change: (a: ReportActivity) => ReportActivity) =>
    write(rows.map((a) => (a.operationId === id ? change(a) : a)));
  const add = () => {
    if (!chosen) return;
    const mapping =
      kind === 'installation'
        ? day.activityMappings?.find((m) => m.workItemKey === chosen.key)
        : undefined;
    const legacy =
      kind === 'installation' &&
      !rows.some(
        (a) => a.workItemKey === chosen.key && a.outputKind === 'installation',
      )
        ? (h.facts?.qty[chosen.key] ?? '')
        : '';
    const a = newActivity(chosen, mapping, dec(legacy) === null ? '' : legacy);
    a.process = label(chosen.label);
    a.outputKind = kind;
    write([...rows, a]);
  };
  if (!supported) return null;
  return (
    <section aria-label={text.activities}>
      <h3>{text.activities}</h3>
      {!locked && (
        <div className="activity-scope">
          <label className="field">
            <span>{text.work}</span>
            <select
              value={chosen?.key ?? ''}
              onChange={(e) => setSelected(e.target.value)}
            >
              {work.map((w) => (
                <option key={w.key} value={w.key}>
                  {label(w.label)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{text.output}</span>
            <select
              value={kind}
              onChange={(e) =>
                setKind(e.target.value as ReportActivity['outputKind'])
              }
            >
              <option value="installation">{text.installation}</option>
              <option value="process">{text.predecessor}</option>
              <option value="activity">{text.noQuantity}</option>
            </select>
          </label>
          <button
            type="button"
            className="ghost"
            disabled={!chosen}
            onClick={add}
          >
            {text.add}
          </button>
          {chosen &&
            !rows.some(
              (a) =>
                a.workItemKey === chosen.key && a.outputKind === 'installation',
            ) &&
            h.facts?.qty[chosen.key] && (
              <p className="small">
                {text.adoptExisting}
                {h.facts.qty[chosen.key]}
              </p>
            )}
        </div>
      )}
      {rows.map((a) => {
        const use = a.use;
        const material = materials.find((m) => m.key === use?.materialKey);
        return (
          <ActivityCard
            key={a.operationId}
            locked={locked}
            areaLocked={use?.state === 'calculated' && !!use.estimate}
            value={{
              id: a.operationId,
              area: a.area,
              scope: label(
                work.find((w) => w.key === a.workItemKey)?.label ?? a.process,
              ),
              process: a.process,
              completion: a.completion,
              quantity: a.quantity,
              outputUnit: label(`u_${a.outputUnit}`).replace(/^u_/, ''),
              material: material ? label(material.label) : null,
              consumption:
                use?.state === 'calculated'
                  ? (use.estimate?.quantity ?? '')
                  : (use?.actualQuantity ?? ''),
              materialUnit: label(`u_${use?.unit ?? ''}`).replace(/^u_/, ''),
              consumptionState:
                use?.state === 'calculated'
                  ? 'estimated'
                  : (use?.state ?? 'pending'),
              explanation: use?.differenceNote ?? '',
              reviewRequired: use?.reviewRequired ?? false,
            }}
            onChange={(field, value) =>
              update(a.operationId, (row) => editActivity(row, field, value))
            }
            onPending={(pending) =>
              update(a.operationId, (row) => pendingActivityUse(row, pending))
            }
            materialChoice={
              !material && use ? (
                <label className="field">
                  <span>{text.material}</span>
                  <select
                    value=""
                    onChange={(e) =>
                      update(a.operationId, (row) => {
                        const m = materials.find(
                          (v) => v.key === e.target.value,
                        );
                        const next = structuredClone(row);
                        if (m && next.use) {
                          next.use.materialItemId = null;
                          next.use.materialKey = m.key;
                          next.use.unit = m.unit;
                        }
                        return next;
                      })
                    }
                  >
                    <option value="">{text.pending}</option>
                    {materials.map((m) => (
                      <option key={m.key} value={m.key}>
                        {label(m.label)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : undefined
            }
            photos={<PhotoLine link={{ type: 'item', id: a.workItemKey }} />}
          />
        );
      })}
    </section>
  );
}

/** All views read the same use fact; no separate material-use editor or inventory posting. */
export function ActivitySummary({
  activities,
  items,
  confirmation = false,
}: {
  activities: readonly ReportActivity[];
  items: readonly ReportItemDto[];
  confirmation?: boolean;
}) {
  const { lang, label } = useI18n();
  const text = activityText(lang);
  if (!activities.length) return null;
  const uses = consumptionRows(activities);
  const declared = new Map<string, bigint>();
  for (const u of uses)
    if (
      u.state === 'declared' &&
      u.materialKey &&
      dec(u.actualQuantity) !== null
    )
      declared.set(
        u.materialKey,
        (declared.get(u.materialKey) ?? 0n) + dec(u.actualQuantity)!,
      );
  return (
    <section
      className="activity-summary"
      aria-label={confirmation ? text.submit : text.activities}
    >
      {confirmation && <p>{text.submitHint}</p>}
      {activities.map((a) => (
        <div className="activity-consumption-row" key={a.outputFactId}>
          <b>
            {a.area} · {a.process}
          </b>
          <div>
            {text.output}: {a.quantity || text.missing}{' '}
            {label(`u_${a.outputUnit}`).replace(/^u_/, '')}
            {a.completion && ` · ${a.completion}`}
          </div>
          {a.use && (
            <div>
              {text.actual}:{' '}
              {label(
                items.find(
                  (i) => i.key === a.use?.materialKey && i.kind === 'material',
                )?.label ?? text.pending,
              )}{' '}
              ·{' '}
              {a.use.state === 'pending'
                ? text.pending
                : `${(a.use.state === 'calculated' ? a.use.estimate?.quantity : a.use.actualQuantity) || text.missing} ${label(`u_${a.use.unit}`).replace(/^u_/, '')}`}
              {a.use.state !== 'pending' && (
                <p className="muted small">
                  {a.use.state === 'calculated'
                    ? text.estimate
                    : text[a.use.state]}
                </p>
              )}
              {a.use.differenceNote && <p>{a.use.differenceNote}</p>}
              {a.use.reviewRequired && (
                <p className="banner warn">{text.review}</p>
              )}
            </div>
          )}
        </div>
      ))}
      {declared.size > 0 && (
        <p>
          {text.subtotal}:{' '}
          {[...declared]
            .map(
              ([key, qty]) =>
                `${label(items.find((i) => i.kind === 'material' && i.key === key)?.label ?? key)} ${decText(qty)} ${label(`u_${items.find((i) => i.kind === 'material' && i.key === key)?.unit ?? ''}`).replace(/^u_/, '')}`,
            )
            .join(' · ')}
        </p>
      )}
      <p className="muted small">{text.unknownHistory}</p>
    </section>
  );
}
