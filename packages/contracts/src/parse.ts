/**
 * Strict parser building blocks shared by the boundary DTO parsers (report, issues).
 * Internal to the package: not re-exported from the index except through report.ts.
 */

/** `field` is a bounded, printable path: rejected client keys are never echoed verbatim. */
export class InvalidReportInput extends Error {
  public readonly field: string;
  constructor(field: string) {
    const safe = field.replace(/[^\x20-\x7e]/g, '?').slice(0, 80);
    super(`Invalid field: ${safe}`);
    this.field = safe;
  }
}

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Master-row key (work item, machinery, material): a letter, then up to KEY_MAX - 1 more. */
export const KEY_MAX = 64;
export const KEY = /^[A-Za-z][\w-]{0,63}$/;
export const TEXT_MAX = 4000;

/** Calendar-valid YYYY-MM-DD only; `Date.parse` would roll 2026-02-30 over to March. */
export function isRealDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export function obj(v: unknown, field: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new InvalidReportInput(field);
  return v as Record<string, unknown>;
}
export function str(v: unknown, field: string, max = TEXT_MAX): string {
  if (typeof v !== 'string' || v.length > max)
    throw new InvalidReportInput(field);
  return v;
}
export function id(v: unknown, field: string): string {
  const s = str(v, field, 36);
  if (!UUID.test(s)) throw new InvalidReportInput(field);
  return s.toLowerCase();
}
export function date(v: unknown, field: string): string {
  const s = str(v, field, 10);
  if (!isRealDate(s)) throw new InvalidReportInput(field);
  return s;
}
export function version(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1_000_000)
    throw new InvalidReportInput(field);
  return v;
}
export function oneOf<T extends readonly string[]>(
  v: unknown,
  list: T,
  field: string,
): T[number] {
  if (typeof v !== 'string' || !(list as readonly string[]).includes(v))
    throw new InvalidReportInput(field);
  return v as T[number];
}
/** A master-row key; the same 64-character limit as the rows themselves and the database. */
export function itemKey(v: unknown, field: string): string {
  const s = str(v, field, KEY_MAX);
  if (!KEY.test(s)) throw new InvalidReportInput(field);
  return s;
}
