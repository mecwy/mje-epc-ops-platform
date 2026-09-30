import { useI18n } from '../i18n.js';
import { refusalKey } from './errors.js';

/** The user message for a field or PM error code (never the raw code or body). */
export function ErrorText({
  code,
  uncertain = false,
}: {
  code: string | null;
  /** An earlier attempt of the refused command went unanswered (it may have been recorded). */
  uncertain?: boolean;
}) {
  const { t } = useI18n();
  const key = refusalKey(code, uncertain);
  return <>{t(key)}</>;
}
