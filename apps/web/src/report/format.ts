import { dec, decText, isToken } from '@mje/domain/rules';

/** Site business date (YYYY-MM-DD) in the project's timezone, never the device's. */
export function siteToday(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
}
export function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/**
 * Grouped for reading in the user's locale. The whole part is grouped by Intl as a BigInt and
 * the fraction is appended as typed, so no value ever passes through a float.
 */
export function fmtNum(raw: string | null | undefined, locale: string): string {
  const n = dec(raw ?? '');
  if (n === null) return raw ?? '';
  const [whole = '0', frac] = decText(n).split('.');
  const grouped = new Intl.NumberFormat(locale).format(BigInt(whole));
  if (!frac) return grouped;
  const point =
    new Intl.NumberFormat(locale)
      .formatToParts(1.5)
      .find((p) => p.type === 'decimal')?.value ?? '.';
  return `${grouped}${point}${frac}`;
}
export type Shown =
  | { kind: 'blank' }
  | { kind: 'token'; token: 'unknown' | 'na' }
  | { kind: 'number'; text: string }
  | { kind: 'invalid'; raw: string };
/** Blank, explicit tokens and numbers stay distinct on screen (blank ≠ 0 ≠ unknown). */
export function shown(raw: string | undefined, locale: string): Shown {
  const v = (raw ?? '').trim();
  if (!v) return { kind: 'blank' };
  if (isToken(v)) return { kind: 'token', token: v };
  if (dec(v) !== null) return { kind: 'number', text: fmtNum(v, locale) };
  return { kind: 'invalid', raw: v };
}
export function fmtDay(date: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}
export function fmtShort(date: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'numeric',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}
export function fmtTime(iso: string, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(iso));
}
