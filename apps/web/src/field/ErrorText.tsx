import { useI18n } from '../i18n.js';
import { fieldErrorKey } from './errors.js';

/** The user message for a field or PM error code (never the raw code or body). */
export function ErrorText({ code }: { code: string | null }) {
  const { t } = useI18n();
  const key = fieldErrorKey(code);
  return <>{t(key)}</>;
}
