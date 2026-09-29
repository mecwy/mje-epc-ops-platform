import { useEffect, useReducer } from 'react';
import type { PlanRowDto } from '@mje/contracts';
import { dec } from '@mje/domain/rules';
import type { DayView } from '../api.js';
import { useI18n } from '../i18n.js';
import { Icon } from '../icons.js';
import { Chip, NumInput } from '../ui.js';
import { byKind } from './model.js';
import { fmtDay, fmtNum } from './format.js';
import type { PlanSession } from './plan-session.js';

/**
 * Tomorrow's plan. Edits save as the target day's draft; "confirm" turns the draft into a
 * numbered version, which becomes that day's baseline. A draft is never a baseline. The
 * PlanSession (one per project and target date) owns all writes; this is only its view.
 */
export function PlanEditor({
  session,
  day,
  canWrite,
  onChanged,
}: {
  session: PlanSession;
  day: DayView;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const { t, label, locale } = useI18n();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const listeners = planListeners(session);
    listeners.add(rerender);
    void session.load();
    return () => {
      listeners.delete(rerender);
      // Leaving the editor writes what was typed; the session keeps a failure for return.
      if (session.dirty) session.save().catch(() => undefined);
    };
  }, [session]);

  const { plan, rows, confirming, error } = session;
  if (!plan) return <p className="muted">{error ?? t('loading')}</p>;
  const editable = canWrite && !confirming;
  const valid = rows.every((r) => r.target === '' || dec(r.target) !== null);
  const change = (next: PlanRowDto[]) => session.edit(next);
  const work = byKind(day.items, 'work');
  const inPlan = new Set(rows.map((r) => r.item));
  const addable = work.filter((i) => !inPlan.has(i.key));
  const status = plan.status;
  const message =
    error === 'PLAN_EMPTY'
      ? t('emptyPlan')
      : error === 'NUMBER_INVALID'
        ? t('numberInvalid')
        : error;
  return (
    <>
      <div className="plan-h">
        <b>{fmtDay(session.target, locale)}</b>
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
                disabled={!editable}
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
                  disabled={!editable}
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
              disabled={!editable}
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
        {message && <div className="banner err">{message}</div>}
      </section>
      {canWrite && status.status !== 'confirmed' && (
        <button
          type="button"
          className="primary wide"
          disabled={confirming || !valid}
          onClick={() =>
            session
              .confirm()
              .then(onChanged)
              .catch(() => undefined)
          }
        >
          {t('confirmPlan')}
        </button>
      )}
    </>
  );
}

/** Components listening to a PlanSession while mounted (the session calls them on change). */
const listeners = new WeakMap<PlanSession, Set<() => void>>();
export function planListeners(session: PlanSession): Set<() => void> {
  let set = listeners.get(session);
  if (!set) listeners.set(session, (set = new Set()));
  return set;
}
