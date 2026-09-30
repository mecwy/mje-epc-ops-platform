import { createContext, useContext, useState } from 'react';
import type { CrewItemStatusDto } from '@mje/contracts';
import type { ForemanDayView } from '../api.js';
import { useI18n } from '../i18n.js';
import { ErrorText } from '../field/ErrorText.js';
import { fmtNum, fmtStamp } from './format.js';
import { adoptBlock, itemView, type AdoptFlow } from './foreman-adopt.js';

/** What the report pages need of the field slice (writers only; a reader gets null). */
export interface PmField {
  foreman: ForemanDayView | null;
  adopt: AdoptFlow | null;
  canWrite: boolean;
  dayState: string;
  timeZone: string;
  /** The day's check-in summary, shown beside the declared headcount; never fills it. */
  checkIns: {
    present: number;
    self: number;
    proxy: number;
    flagged: number;
  } | null;
}
export const PmFieldContext = createContext<PmField | null>(null);
export const usePmField = () => useContext(PmFieldContext);

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
  const [error, setError] = useState<string | null>(null);
  if (!pm?.foreman) return null;
  const f = pm.foreman;
  const v = itemView(f, itemKey);
  if (!v || v.crews.length === 0) return null;
  const block = adoptBlock(v, pm);
  const flow = pm.adopt;
  const seen = flow?.changed[itemKey];
  // This item's adoption while it runs or is unresolved: shown as sent (C51).
  const owned =
    flow?.owned.current?.item === itemKey ? flow.owned.current : null;
  const unresolved = owned !== null && flow?.owned.unresolved !== null;
  const busy = flow?.owned.session.busy ?? false;
  const total =
    v.status === 'COMPLETE' && v.value !== null
      ? t('fa_total', { v: fmtNum(v.value, locale) })
      : v.status === 'ALL_NA'
        ? t('fa_allNa')
        : v.status === 'OVERFLOW'
          ? t('fa_overflow')
          : v.atLeast !== null
            ? t('fa_atLeast', { v: fmtNum(v.atLeast, locale) })
            : t('fa_partial');
  const use = async () => {
    if (!flow || v.value === null) return;
    setError(null);
    const r = unresolved
      ? await flow.retry()
      : await flow.adopt(itemKey, { basis: f.basis, value: v.value });
    if (r.kind === 'rejected' || r.kind === 'failed') setError(r.code);
  };
  return (
    <div className="fline">
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
      {seen !== undefined && (
        <div className="banner warn" role="alert">
          {t('fa_changed', {
            was: seen === null ? '—' : fmtNum(seen, locale),
            now: v.value === null ? '—' : fmtNum(v.value, locale),
          })}
        </div>
      )}
      {open && (
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
      {f.expectedCrewsChanged && (
        <p className="muted small">{t('fa_crewsChanged')}</p>
      )}
      {error && (
        <div className="banner err" role="alert">
          <ErrorText code={error} />
        </div>
      )}
      {owned && (
        <div className="banner warn" role="alert">
          {unresolved
            ? t('fa_adoptUnresolved', { v: fmtNum(owned.value, locale) })
            : t('saving')}
        </div>
      )}
      {flow && owned && unresolved && (
        <span className="chips">
          <button
            type="button"
            className="pill"
            disabled={busy}
            onClick={() => flow.discard()}
          >
            {t('pm_giveUp')}
          </button>
          <button
            type="button"
            className="pill accent"
            disabled={busy}
            onClick={() => void use()}
          >
            {t('retry')}
          </button>
        </span>
      )}
      {flow && !owned && block === null && (
        <button
          type="button"
          className="pill accent"
          disabled={busy || !flow.owned.canStart}
          onClick={() => void use()}
        >
          {t('adoptN', { n: fmtNum(v.value ?? '', locale) })}
        </button>
      )}
      {block === 'notComplete' && pm.canWrite && (
        <p className="muted small">{t('fa_notAdoptable')}</p>
      )}
    </div>
  );
}

/** The check-in count beside the declared headcount (U8); a writer only. */
export function CheckInsBeside() {
  const { t } = useI18n();
  const pm = usePmField();
  if (!pm?.checkIns) return null;
  return (
    <span className="muted small">
      {t('fa_checkIns', {
        n: pm.checkIns.present,
        s: pm.checkIns.self,
        p: pm.checkIns.proxy,
      })}
    </span>
  );
}
