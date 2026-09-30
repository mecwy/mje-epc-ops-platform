import { useI18n } from '../i18n.js';
import type { DayHandle } from './useDay.js';

/**
 * A day still locked because the read after its command failed: why (worded by what the
 * command did: saved, refused, or unknown) and a Refresh that frees it once a read lands.
 */
export function DayRecovery({
  h,
}: {
  h: Pick<DayHandle, 'stale' | 'staleOutcome' | 'reloadLocked'>;
}) {
  const { t } = useI18n();
  if (!h.stale) return null;
  const key =
    h.staleOutcome === 'saved'
      ? 'dayRereadFailed'
      : h.staleOutcome === 'refused'
        ? 'dayRereadFailedRefused'
        : 'dayRereadFailedUnknown';
  return (
    <div className="banner warn" role="alert">
      {t(key)}{' '}
      <button
        type="button"
        className="textbtn"
        onClick={() => void h.reloadLocked()}
      >
        {t('pm_reload')}
      </button>
    </div>
  );
}
