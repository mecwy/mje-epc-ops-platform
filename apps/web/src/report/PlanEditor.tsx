import { useEffect, useId, useReducer, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { PlanRowDto } from '@mje/contracts';
import { dec } from '@mje/domain/rules';
import type { DayView } from '../api.js';
import { useI18n } from '../i18n.js';
import { Icon } from '../icons.js';
import { Chip } from '../ui.js';
import { byKind } from './model.js';
import { fmtDay, fmtNum } from './format.js';
import { PlanQuantityEntry, type PlanSession } from './plan-session.js';

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
  const dialog = useRef<HTMLDialogElement>(null);
  const entry = useRef(new PlanQuantityEntry());
  const [item, setItem] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [invalid, setInvalid] = useState(false);
  const titleId = useId();
  const fieldId = useId();
  const errorId = useId();
  const opener = useRef<HTMLElement | null>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const work = byKind(day.items, 'work');
  const editable = canWrite && !session.confirming && session.plan !== null;
  const context = (key: string) => {
    const row = session.rows.find((r) => r.item === key);
    return {
      owner: session,
      item: key,
      unit: work.find((it) => it.key === key)?.unit ?? '',
      value: row?.target ?? '',
      present: row !== undefined,
      locked: !editable,
    };
  };

  function closeEntry() {
    entry.current.cancel();
    if (dialog.current?.open) dialog.current.close();
    if (opener.current?.isConnected) opener.current.focus();
    else if (item) triggers.current.get(item)?.focus();
  }

  function openEntry(key: string, trigger: HTMLButtonElement) {
    const node = dialog.current;
    if (!node || node.open || !entry.current.open(context(key))) return;
    opener.current = trigger;
    // Keep focus inside the original tap so mobile browsers can open the keyboard.
    flushSync(() => {
      setItem(key);
      setInput(entry.current.value);
      setInvalid(false);
    });
    node.showModal();
    node.querySelector('input')?.focus();
    node.querySelector('input')?.select();
  }

  function completeEntry() {
    if (!item) return;
    const current = context(item);
    const result = entry.current.complete(current);
    if (result.kind === 'invalid') {
      setInvalid(true);
      dialog.current?.querySelector('input')?.focus();
      return;
    }
    if (
      result.kind === 'apply' &&
      (!current.present || result.value !== current.value)
    ) {
      const next = current.present
        ? session.rows.map((r) =>
            r.item === item ? { ...r, target: result.value } : r,
          )
        : [...session.rows, { item, target: result.value }];
      flushSync(() => session.edit(next));
    }
    closeEntry();
  }

  useEffect(() => {
    if (item && dialog.current?.open && !entry.current.current(context(item)))
      closeEntry();
  });
  useEffect(() => {
    const node = dialog.current;
    const buffer = entry.current;
    return () => {
      buffer.cancel();
      if (node?.open) node.close();
    };
  }, []);

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
  const valid = rows.every((r) => r.target === '' || dec(r.target) !== null);
  const change = (next: PlanRowDto[]) => session.edit(next);
  const inPlan = new Set(rows.map((r) => r.item));
  const addable = work.filter((i) => !inPlan.has(i.key));
  const status = plan.status;
  const selected = work.find((x) => x.key === item);
  const message =
    error === 'PLAN_EMPTY'
      ? t('emptyPlan')
      : error === 'NUMBER_INVALID'
        ? t('numberInvalid')
        : error;
  return (
    <>
      <div className="plan-h">
        <b>
          <time dateTime={session.target}>
            {fmtDay(session.target, locale)}
          </time>
        </b>
        {status.status === 'confirmed' && !session.dirty && (
          <Chip tone="ok">{t('confirmedN', { n: status.n ?? 0 })}</Chip>
        )}
        {(status.status === 'draft' || session.dirty) && (
          <Chip>
            {status.n ? `${t('confirmedN', { n: status.n })} · ` : ''}
            {t('draft')}
            {!session.dirty && !error && plan.draft ? ` · ${t('saved')}` : ''}
          </Chip>
        )}
        {status.status === 'none' && (
          <Chip>
            {session.referenceOnly
              ? t('planPreviousReference')
              : t('notPlanned')}
          </Chip>
        )}
      </div>
      <section className="card">
        {rows.length === 0 && <p className="muted">{t('notPlanned')}</p>}
        {rows.map((r, i) => {
          const it = work.find((x) => x.key === r.item);
          const today = day.facts.qty[r.item];
          return (
            <div className="qline" key={r.item}>
              <button
                type="button"
                className="grow fill-quantity-trigger"
                disabled={!editable}
                ref={(node) => {
                  if (node) triggers.current.set(r.item, node);
                  else triggers.current.delete(r.item);
                }}
                onClick={(e) => openEntry(r.item, e.currentTarget)}
              >
                <span className="qname">{it ? label(it.label) : r.item}</span>
                <span className="muted small">
                  <time dateTime={day.businessDate}>
                    {fmtDay(day.businessDate, locale)}
                  </time>{' '}
                  ·{' '}
                  {today !== undefined && today !== ''
                    ? fmtNum(today, locale)
                    : t('notFilled')}
                </span>
                <span>
                  {t('planned')} ·{' '}
                  {r.target === '' ? t('notFilled') : fmtNum(r.target, locale)}{' '}
                  {it?.unit ?? ''}
                </span>
              </button>
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
          <div className="field">
            <span>{t('addWork')}</span>
            {addable.map((it) => (
              <button
                key={it.key}
                type="button"
                className="fill-quantity-trigger"
                disabled={!editable}
                onClick={(e) => openEntry(it.key, e.currentTarget)}
              >
                <span className="qname">{label(it.label)}</span>
                <span className="muted small">{it.unit}</span>
              </button>
            ))}
          </div>
        )}
        {!valid && <div className="banner err">{t('numberInvalid')}</div>}
        {message && <div className="banner err">{message}</div>}
      </section>
      {canWrite && (
        <button
          type="button"
          className="ghost wide"
          disabled={
            confirming || !valid || (!session.dirty && !session.referenceOnly)
          }
          onClick={() =>
            (session.referenceOnly
              ? session.saveReferenceDraft()
              : session.save()
            ).catch(() => undefined)
          }
        >
          {t('save')} · {t('draft')}
        </button>
      )}
      {canWrite && status.status !== 'confirmed' && (
        <button
          type="button"
          className="primary wide"
          disabled={
            confirming ||
            !valid ||
            (!session.hasOwnDraft && !session.dirty) ||
            !rows.some((row) => row.target !== '')
          }
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
      <dialog
        ref={dialog}
        className="sheet fill-quantity-sheet"
        aria-labelledby={titleId}
        onCancel={(e) => {
          e.preventDefault();
          closeEntry();
        }}
        onClick={(e) => {
          if (e.target === dialog.current) closeEntry();
        }}
      >
        <div className="sheet-h">
          <h2 id={titleId}>{selected ? label(selected.label) : item}</h2>
        </div>
        <div className="sheet-b">
          <p>{fmtDay(session.target, locale)}</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              completeEntry();
            }}
          >
            <label htmlFor={fieldId}>{t('planned')}</label>
            <div className="fill-quantity-value">
              <input
                id={fieldId}
                className="num qty"
                inputMode="decimal"
                autoComplete="off"
                value={input}
                disabled={!editable}
                aria-invalid={invalid || undefined}
                aria-describedby={invalid ? errorId : undefined}
                onChange={(e) => {
                  entry.current.edit(e.target.value);
                  setInput(e.target.value);
                  setInvalid(false);
                }}
              />
              {selected?.unit && <span>{selected.unit}</span>}
            </div>
            {invalid && (
              <p id={errorId} role="alert" className="bad-t">
                {t('numberInvalid')}
              </p>
            )}
            <div className="fill-quantity-actions">
              <button type="button" className="ghost" onClick={closeEntry}>
                {t('back')}
              </button>
              <button type="submit" className="primary" disabled={!editable}>
                {t('fill')}
              </button>
            </div>
          </form>
        </div>
      </dialog>
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
