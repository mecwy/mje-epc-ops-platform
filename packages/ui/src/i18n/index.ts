import {
  LANGS,
  LOCALES,
  MESSAGES,
  type Lang,
  type MessageKey,
} from './messages.js';
import { isCheckedNoIssues } from './presets.js';

export { LANGS, LOCALES, MESSAGES };
export type { Lang, MessageKey };
export {
  CHECKED_NO_ISSUES,
  LEGACY_CHECKED_NO_ISSUES,
  isCheckedNoIssues,
} from './presets.js';

const ORDER: Lang[] = ['zh', 'en', 'sr', 'es'];

export function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && (ORDER as string[]).includes(v);
}

/**
 * Translate a key. Missing keys and empty entries fall back to the key itself so a gap is
 * visible on screen rather than silently blank (ML-01). Variables use `{name}`.
 */
export function translate(
  lang: Lang,
  key: MessageKey,
  vars: Record<string, string | number> = {},
): string {
  const row = Object.hasOwn(MESSAGES, key)
    ? (MESSAGES as Record<string, readonly string[]>)[key]
    : undefined;
  const index = ORDER.indexOf(lang);
  const text = row?.[index] || row?.[0] || key;
  // One pass with a callback: values are inserted literally and are never re-scanned.
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match,
  );
}

/**
 * Display text for a stored quality/safety value: the preset code (or the exact legacy Chinese
 * preset) in the reader's language; anything else is returned exactly as typed.
 */
export function narrativeText(stored: string, lang: Lang): string {
  return isCheckedNoIssues(stored) ? translate(lang, 'noCheckFound') : stored;
}

export const makeT =
  (lang: Lang) => (key: MessageKey, vars?: Record<string, string | number>) =>
    translate(lang, key, vars);

/** Initial language: saved preference, else a browser-language suggestion, else zh. */
export function initialLang(
  saved: unknown,
  browserLanguages: readonly string[],
): Lang {
  if (isLang(saved)) return saved;
  for (const bl of browserLanguages) {
    const base = bl.toLowerCase().split('-')[0];
    if (isLang(base)) return base;
  }
  return 'zh';
}
