import { useContext, useState } from 'react';
import type { CrewItemStatusDto } from '@mje/contracts';
import { useI18n } from '../i18n.js';
import { ErrorText } from '../field/ErrorText.js';
import { fmtNum, fmtStamp } from './format.js';
import { PmFieldContext } from './CheckInsBeside.js';
import { adoptBlock, itemView } from './foreman-adopt.js';

export { PmFieldContext, type PmField } from './CheckInsBeside.js';
const usePmField = () => useContext(PmFieldContext);

const CREW_STATUS = {
  MISSING_REPORT: 'fa_crew_MISSING_REPORT',
  OMITTED: 'fa_crew_OMITTED',
  UNKNOWN: 'fa_crew_UNKNOWN',
  NA: 'fa_crew_NA',
  ZERO: 'fa_crew_ZERO',
  VALUE: 'fa_crew_VALUE',
} as const satisfies Record<CrewItemStatusDto, string>;

/**
 * The foreman claims for one item beside the PM's figure (design §4): the total and its
 * completeness, each expected crew's status, and an explicit "use" only for a COMPLETE total.
 * A difference from the PM's figure is shown, never treated as an issue; nothing is adopted
 * automatically. After FOREMAN_TOTAL_CHANGED the new total is shown beside the one seen.
 */
export function ForemanLine({ itemKey }: { itemKey: string }) {
  const { t, locale } = useI18n();
  const pm = usePmField();
  const [open, setOpen] = useState(false);
  // Only a failure before anything was sent (typed facts not saved, busy); an adoption's own
  // outcome comes from its owner (AdoptFlow), the same for a first send and a Retry.
  const [problem, setProblem] = useState<string | null>(null);
  const flow = pm?.adopt ?? null;
  // This item's adoption at any stage (saving typed facts, sending, unresolved, reading the
  // day again): shown as sent (C51), whatever the live total is now.
  const active = flow?.active?.item === itemKey ? flow.active : null;
  const unresolved = flow !== null && flow.owned.unresolved?.item === itemKey;
  const busy = flow?.owned.session.busy ?? false;
  const refused =
    flow &&
    !active &&
    flow.owned.refused?.item === itemKey &&
    flow.owned.refusal &&
    flow.owned.refusal !== 'FOREMAN_TOTAL_CHANGED'
      ? { code: flow.owned.refusal, uncertain: flow.owned.refusalUncertain }
      : null;
  const f = pm?.foreman ?? null;
  const found = f ? itemView(f, itemKey) : null;
  const v = found && found.crews.length > 0 ? found : null;
  const seen = flow?.changed[itemKey];
  if (!pm || (!v && !active && !refused && seen === undefined)) return null;
  const block = v ? adoptBlock(v, pm) : 'notComplete';
  const total = !v
    ? null
    : v.status === 'COMPLETE' && v.value !== null
      ? t('fa_total', { v: fmtNum(v.value, locale) })
      : v.status === 'ALL_NA'
        ? t('fa_allNa')
        : v.status === 'OVERFLOW'
          ? t('fa_overflow')
          : v.atLeast !== null
            ? t('fa_atLeast', { v: fmtNum(v.atLeast, locale) })
            : t('fa_partial');
  const use = async () => {
    if (!flow || !f || !v || v.value === null) return;
    setProblem(null);
    const r = await flow.adopt(itemKey, { basis: f.basis, value: v.value });
    if (r.kind === 'failed' && !flow.active) setProblem(r.code);
  };
  // The owned payload is resent as it is, whether or not the live total is adoptable now.
  const retry = async () => {
    if (!flow) return;
    setProblem(null);
    await flow.retry();
  };
  return (
    <div className="fline entry-adoption">
      <p className="entry-context">{t('entryAdoptionOnly')}</p>
      {v && (
        <button
          type="button"
          className="plain fline-h"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className={v.status === 'COMPLETE' ? 'ok-t' : 'warn-t'}>
            {total}
          </span>
          {v.adopted && (
            <span className="muted small">
              {' '}
              ·{' '}
              {t('fa_adopted', {
                v: fmtNum(v.adopted.value, locale),
                t: fmtStamp(v.adopted.at, locale, pm.timeZone),
              })}
            </span>
          )}
        </button>
      )}
      {seen !== undefined && (
        <div className="banner warn" role="alert">
          {t('fa_changed', {
            was: seen === null ? '—' : fmtNum(seen, locale),
            now: !v || v.value === null ? '—' : fmtNum(v.value, locale),
          })}
        </div>
      )}
      {open && v && (
        <ul className="plainlist small">
          {v.crews.map((c) => {
            const key = CREW_STATUS[c.status];
            return (
              <li key={c.crewId} className="fcrew">
                <span className="grow">
                  {c.name}
                  {!c.hasForeman && ` · ${t('fa_noForeman')}`}
                </span>
                <span
                  className={
                    c.status === 'VALUE' || c.status === 'ZERO' ? '' : 'warn-t'
                  }
                >
                  {c.status === 'VALUE' && c.qty
                    ? fmtNum(c.qty, locale)
                    : t(key)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {f?.expectedCrewsChanged && (
        <p className="muted small">{t('fa_crewsChanged')}</p>
      )}
      {problem && (
        <div className="banner err" role="alert">
          <ErrorText code={problem} />
        </div>
      )}
      {refused && (
        <div className="banner err" role="alert">
          <ErrorText code={refused.code} write uncertain={refused.uncertain} />
        </div>
      )}
      {active && (
        <div className="banner warn" role="alert">
          {unresolved ? (
            <>
              {t('fa_adoptUnresolved', { v: fmtNum(active.value, locale) })}{' '}
              <ErrorText code={flow?.owned.session.error ?? 'NETWORK'} write />
            </>
          ) : (
            t('saving')
          )}
        </div>
      )}
      {flow && active && unresolved && !flow.workspaceRecovery && (
        <span className="chips">
          <button
            type="button"
            className="pill"
            disabled={busy}
            onClick={() => void flow.discard()}
          >
            {t('pm_giveUp')}
          </button>
          <button
            type="button"
            className="pill accent"
            disabled={busy}
            onClick={() => void retry()}
          >
            {t('retry')}
          </button>
        </span>
      )}
      {flow && v && !active && block === null && (
        <button
          type="button"
          className="pill accent"
          disabled={busy || !flow.canStart}
          onClick={() => void use()}
        >
          {t('adoptN', { n: fmtNum(v.value ?? '', locale) })}
        </button>
      )}
      {v && block === 'notComplete' && pm.canWrite && (
        <p className="muted small">{t('fa_notAdoptable')}</p>
      )}
    </div>
  );
}
