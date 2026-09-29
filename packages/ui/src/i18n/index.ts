import {
  LANGS,
  LOCALES,
  MESSAGES,
  type Lang,
  type MessageKey,
} from './messages.js';

export { LANGS, LOCALES, MESSAGES };
export type { Lang, MessageKey };

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
  key: MessageKey | string,
  vars: Record<string, string | number> = {},
): string {
  const row = (MESSAGES as Record<string, readonly string[]>)[key];
  const index = ORDER.indexOf(lang);
  let text = row?.[index] || row?.[0] || key;
  for (const [name, value] of Object.entries(vars))
    text = text.replaceAll(`{${name}}`, String(value));
  return text;
}

export const makeT =
  (lang: Lang) =>
  (key: MessageKey | string, vars?: Record<string, string | number>) =>
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
