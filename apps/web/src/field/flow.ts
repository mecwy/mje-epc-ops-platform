import type { EntryDto, FieldMeDto } from '@mje/contracts';
import {
  endedReason,
  type DeviceRecord,
  type EndedReason,
} from './device-store.js';
import { ENDED } from './session.js';

/**
 * The device page's states (design §2 lifecycle as the browser sees it). Pure functions so
 * the transitions are tested without a browser.
 */
export type FieldScreen =
  | { kind: 'loading' }
  /** No usable code and no device on this browser. */
  | { kind: 'scan' }
  /** The entry code failed; a device already on this browser can still be opened. */
  | { kind: 'entryFailed'; code: string; device: DeviceRecord | null }
  | { kind: 'roster'; entry: EntryDto; code: string }
  | { kind: 'device'; record: DeviceRecord };

export type Result<T> = { ok: T } | { error: string };

/** Where the page starts: a scanned code wins; otherwise the most recent device here. */
export function startScreen(
  code: string | null,
  entry: Result<EntryDto> | null,
  records: DeviceRecord[],
): FieldScreen {
  if (code && entry) {
    if ('error' in entry)
      return {
        kind: 'entryFailed',
        code: entry.error,
        device: records[0] ?? null,
      };
    const own = records.find((r) => r.projectId === entry.ok.project.id);
    return own
      ? { kind: 'device', record: own }
      : { kind: 'roster', entry: entry.ok, code };
  }
  return records[0] ? { kind: 'device', record: records[0] } : { kind: 'scan' };
}

export type DeviceView =
  | { kind: 'loading' }
  | { kind: 'pending'; me: FieldMeDto }
  | { kind: 'home'; me: FieldMeDto }
  /** The server no longer accepts this device: the token is dropped from the browser. */
  | { kind: 'ended'; reason: EndedReason }
  /** Not answered (offline, busy, rate limited): the device is kept; the user retries. */
  | { kind: 'unreachable'; code: string };

/**
 * What the device page shows from its newest `me` and the last read's error. An ended answer
 * wins over an older good reading; a transient failure keeps showing the last reading.
 */
export function deviceView(
  me: FieldMeDto | null,
  readError: string | null,
  record: DeviceRecord,
  now: Date,
): DeviceView {
  if (readError && ENDED.has(readError))
    return { kind: 'ended', reason: endedReason(record.last, now) };
  if (!me)
    return readError
      ? { kind: 'unreachable', code: readError }
      : { kind: 'loading' };
  const state = me.device.state;
  if (state === 'PENDING') return { kind: 'pending', me };
  if (state === 'CONFIRMED') return { kind: 'home', me };
  return { kind: 'ended', reason: endedReason(record.last, now) };
}

/** A code read from the link's fragment (`#e=…`), never sent to the server in a URL. */
export function codeFromHash(hash: string): string | null {
  const m = /^#e=([A-Za-z0-9_-]{22})$/.exec(hash);
  return m ? m[1]! : null;
}

/** Unregister is offered for any live device, pending too (a wrong name picked by mistake). */
export function canRelease(view: DeviceView): boolean {
  return view.kind === 'pending' || view.kind === 'home';
}
