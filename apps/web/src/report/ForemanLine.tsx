import { createContext, useContext, useState } from 'react';
import type { CrewItemStatusDto } from '@mje/contracts';
import type { ForemanDayView } from '../api.js';
import { useI18n } from '../i18n.js';
import { fmtNum, fmtStamp } from './format.js';
import { itemView } from './foreman-view.js';

/** What the report pages need of the field slice (writers only; a reader gets null). */
export interface PmField {
  foreman: ForemanDayView | null;
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
 * The foreman claims for one item beside the PM's figure (design §4), read-only: the total and
 * its completeness, each expected crew's status, and the latest adoption if any. A difference
 * from the PM's figure is shown, never treated as an issue; nothing fills the PM's figure.
 * (The PM's explicit adoption comes in its own change.)
 */
export function ForemanLine({ itemKey }: { itemKey: string }) {
  const { t, locale } = useI18n();
  const pm = usePmField();
  const [open, setOpen] = useState(false);
  const f = pm?.foreman ?? null;
  const v = f ? itemView(f, itemKey) : null;
  if (!pm || !f || !v || v.crews.length === 0) return null;
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
