import type { ForemanReportCommand, ForemanReportDto } from '@mje/contracts';
import { dec, isToken } from '@mje/domain/rules';
import { shift, siteToday } from '../report/format.js';

/** item key → quantity as typed: a decimal, 'unknown', 'na' or '' (blank). */
export type Draft = Record<string, string>;
export type QtyKind =
  'blank' | 'zero' | 'number' | 'unknown' | 'na' | 'invalid';

/**
 * How a typed quantity will be read (design §4, C34): blank, an explicit 0, a number within
 * Decimal(20,6), unknown, n/a, or invalid. Blank, 0 and unknown are never the same thing.
 */
export function qtyKind(raw: string): QtyKind {
  const v = raw.trim();
  if (!v) return 'blank';
  if (isToken(v)) return v;
  const n = dec(v);
  if (n === null) return 'invalid';
  return n === 0n ? 'zero' : 'number';
}

/** The draft the form starts from: every active item, blank unless the latest revision has it. */
export function draftFrom(dto: ForemanReportDto): Draft {
  const d: Draft = {};
  for (const it of dto.items) d[it.key] = '';
  for (const r of dto.rows) if (r.itemKey in d) d[r.itemKey] = r.qty;
  return d;
}

export type DraftCheck =
  | { ok: true; rows: ForemanReportCommand['rows'] }
  | { ok: false; invalid: string[] };
/**
 * The rows to send: every active item in order, blanks included (a blank is stored as
 * blank, never dropped or turned into 0). Anything the server would refuse as NUMBER_INVALID
 * is named here first; nothing is corrected.
 */
export function checkDraft(dto: ForemanReportDto, draft: Draft): DraftCheck {
  const invalid = dto.items
    .map((i) => i.key)
    .filter((k) => qtyKind(draft[k] ?? '') === 'invalid');
  if (invalid.length) return { ok: false, invalid };
  return {
    ok: true,
    rows: dto.items.map((i) => ({
      itemKey: i.key,
      qty: (draft[i.key] ?? '').trim(),
    })),
  };
}

/**
 * Items another send changed on the server since the draft was started (after
 * REVISION_CONFLICT): the form shows each latest value beside the draft and the foreman sends
 * again knowingly; nothing is merged or overwritten automatically.
 */
export function changedOnServer(base: Draft, latest: Draft): string[] {
  const keys = new Set([...Object.keys(base), ...Object.keys(latest)]);
  return [...keys].filter(
    (k) => (base[k] ?? '').trim() !== (latest[k] ?? '').trim(),
  );
}

/** A foreman may report only for the site's today or yesterday (§1, C33). */
export function reportDays(timeZone: string, now: Date): [string, string] {
  const today = siteToday(timeZone, now);
  return [today, shift(today, -1)];
}
