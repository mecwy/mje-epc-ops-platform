import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlanRowDto } from '@mje/contracts';
import { dec } from '@mje/domain/rules';
import {
  ApiError,
  type DayView,
  type PlanView,
  type ReportApi,
} from '../api.js';
import { useI18n } from '../i18n.js';
import { Icon } from '../icons.js';
import { Chip, NumInput } from '../ui.js';
import { byKind } from './model.js';
import { fmtDay, fmtNum } from './format.js';

/**
 * Tomorrow's plan. Edits save as the day's draft; "confirm" turns the draft into a numbered
 * version, which becomes tomorrow's baseline. A draft is never a baseline.
 */
export function PlanEditor({
  api,
  day,
  target,
  canWrite,
  onChanged,
}: {
  api: ReportApi;
  day: DayView;
  target: string;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const { t, label, locale } = useI18n();
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [rows, setRows] = useState<PlanRowDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(async () => {
    const p = await api.plan(day.projectId, target);
    setPlan(p);
    setRows(p.rows);
  }, [api, day.projectId, target]);
  useEffect(() => {
    void load();
  }, [load]);
  const valid = rows.every((r) => r.target === '' || dec(r.target) !== null);
  const saveDraft = useCallback(
    (next: PlanRowDto[]) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        if (!next.every((r) => r.target === '' || dec(r.target) !== null))
          return;
        try {
          const r = await api.savePlanDraft({
            projectId: day.projectId,
            targetBusinessDate: target,
            clientMutationId: crypto.randomUUID(),
            rows: next,
          });
          setPlan((p) => (p ? { ...p, status: r.status, draft: next } : p));
          setError(null);
        } catch (e) {
          setError(e instanceof ApiError ? e.code : 'REQUEST_FAILED');
        }
      }, 600);
    },
    [api, day.projectId, target],
  );
  const change = (next: PlanRowDto[]) => {
    setRows(next);
    saveDraft(next);
  };
  const confirm = async () => {
    if (timer.current) clearTimeout(timer.current);
    setBusy(true);
    try {
      if (plan?.draft !== rows)
        await api.savePlanDraft({
          projectId: day.projectId,
          targetBusinessDate: target,
          clientMutationId: crypto.randomUUID(),
          rows,
        });
      await api.confirmPlan({
        projectId: day.projectId,
        targetBusinessDate: target,
        clientMutationId: crypto.randomUUID(),
      });
      await load();
      onChanged();
      setError(null);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'REQUEST_FAILED';
      setError(
        code === 'PLAN_EMPTY'
          ? t('emptyPlan')
          : code === 'NUMBER_INVALID'
            ? t('numberInvalid')
            : code,
      );
    } finally {
      setBusy(false);
    }
  };
  if (!plan) return <p className="muted">{t('loading')}</p>;
  const work = byKind(day.items, 'work');
  const inPlan = new Set(rows.map((r) => r.item));
  const addable = work.filter((i) => !inPlan.has(i.key));
  const status = plan.status;
  return (
    <>
      <div className="plan-h">
        <b>{fmtDay(target, locale)}</b>
        {status.status === 'confirmed' && (
          <Chip tone="ok">{t('confirmedN', { n: status.n ?? 0 })}</Chip>
        )}
        {status.status === 'draft' && (
          <Chip>
            {status.n ? `${t('confirmedN', { n: status.n })} · ` : ''}
            {t('draft')}
          </Chip>
        )}
        {status.status === 'none' && <Chip>{t('notPlanned')}</Chip>}
      </div>
      <section className="card">
        {rows.length === 0 && <p className="muted">{t('notPlanned')}</p>}
        {rows.map((r, i) => {
          const it = work.find((x) => x.key === r.item);
          const today = day.facts.qty[r.item];
          return (
            <div className="qline" key={r.item}>
              <label className="grow" htmlFor={`plan-${r.item}`}>
                <span className="qname">{it ? label(it.label) : r.item}</span>
                <span className="muted small">
                  {t('todayOf')} {today ? fmtNum(today, locale) : '—'}
                </span>
              </label>
              <NumInput
                id={`plan-${r.item}`}
                value={r.target}
                disabled={!canWrite}
                onChange={(v) =>
                  change(
                    rows.map((x, j) =>
                      j === i
                        ? {
                            ...x,
                            target:
                              v.trim() === 'unknown' || v.trim() === 'na'
                                ? ''
                                : v,
                          }
                        : x,
                    ),
                  )
                }
              />
              {canWrite && (
                <button
                  type="button"
                  className="icon sm"
                  aria-label={t('remove')}
                  onClick={() => change(rows.filter((_, j) => j !== i))}
                >
                  <Icon.close />
                </button>
              )}
            </div>
          );
        })}
        {canWrite && addable.length > 0 && (
          <label className="field">
            <span>{t('addWork')}</span>
            <select
              value=""
              onChange={(e) =>
                e.target.value &&
                change([...rows, { item: e.target.value, target: '' }])
              }
            >
              <option value="">—</option>
              {addable.map((i) => (
                <option key={i.key} value={i.key}>
                  {label(i.label)}
                </option>
              ))}
            </select>
          </label>
        )}
        {!valid && <div className="banner err">{t('numberInvalid')}</div>}
        {error && <div className="banner err">{error}</div>}
      </section>
      {canWrite && status.status !== 'confirmed' && (
        <button
          type="button"
          className="primary wide"
          disabled={busy || !valid}
          onClick={() => void confirm()}
        >
          {t('confirmPlan')}
        </button>
      )}
    </>
  );
}
