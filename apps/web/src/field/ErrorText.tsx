import { useI18n } from '../i18n.js';
import { outcomeKey } from './errors.js';

/**
 * The user message for a field or PM error code (never the raw code or body), through the one
 * outcome mapping (errors.ts `outcomeKey`): pass `write` for a command's outcome, so an
 * unsettled code reads as an unknown outcome, and `uncertain` when an earlier attempt of the
 * refused command went unanswered.
 */
export function ErrorText({
  code,
  write = false,
  uncertain = false,
}: {
  code: string | null;
  write?: boolean;
  uncertain?: boolean;
}) {
  const { t } = useI18n();
  return <>{t(outcomeKey(code, { write, uncertain }))}</>;
}
