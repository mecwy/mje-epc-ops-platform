import { createContext, useContext } from 'react';
import type { ForemanDayView } from '../api.js';
import { useI18n } from '../i18n.js';
import type { AdoptFlow } from './foreman-adopt.js';

/** What the report pages need of the field slice (writers only; a reader gets null). */
export interface PmField {
  /** Foreman totals and the PM's explicit adoption (ForemanLine). */
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

/** The check-in count beside the declared headcount (U8); a writer only. */
export function CheckInsBeside() {
  const { t } = useI18n();
  const pm = useContext(PmFieldContext);
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
