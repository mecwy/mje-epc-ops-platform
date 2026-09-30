import type {
  ChallengeConfirmCommand,
  ChallengeRejectCommand,
  FieldMeDto,
  ForemanReportCommand,
  ForemanReportDto,
} from '@mje/contracts';
import { dec, isToken } from '@mje/domain/rules';
import { shift, siteToday } from '../report/format.js';
import type { DeviceApi } from './field-api.js';
import type { OwnedCommands } from './owned-commands.js';
import type { Outcome } from './session.js';

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

export type CrewDecision =
  | { kind: 'confirm'; command: ChallengeConfirmCommand }
  | { kind: 'reject'; command: ChallengeRejectCommand };
/**
 * A foreman's confirm or reject of a crew member's phone, built from the newest reading when
 * it runs (C2): `expectedCurrentDeviceId` is the member's current phone as that reading shows
 * it, so an older view gets CONFIRM_STALE. Null when the person is no longer in the crew.
 */
export function crewDecision(
  me: FieldMeDto | null,
  personId: string,
  code: string,
  key: string,
  what: 'confirm' | 'reject',
): CrewDecision | null {
  const m = me?.foreman?.members.find((x) => x.personId === personId);
  if (!m) return null;
  return what === 'confirm'
    ? {
        kind: 'confirm',
        command: {
          clientMutationId: key,
          personId,
          code,
          expectedCurrentDeviceId: m.currentDeviceId,
        },
      }
    : { kind: 'reject', command: { clientMutationId: key, personId, code } };
}

/** A report send as sent: its rows (blanks kept), note and the revision it was edited from. */
export interface ReportSend {
  rows: { itemKey: string; qty: string }[];
  note: string;
  editedFrom: number;
}
/**
 * Send a report as edited (AGENTS.md: form state = the owned command's payload): the command
 * carries the revision the draft was edited from, never a newer one read later, so a stale
 * draft gets REVISION_CONFLICT instead of replacing a revision the foreman has not seen.
 */
export function sendReport(
  sends: OwnedCommands<ForemanReportDto, ReportSend>,
  api: Pick<DeviceApi, 'submitReport'>,
  businessDate: string,
  payload: ReportSend,
  now: () => Date = () => new Date(),
): Promise<Outcome<unknown>> {
  return sends.run(payload, (d, key) => {
    if (!d) return null;
    return {
      key,
      send: () =>
        api.submitReport({
          clientMutationId: key,
          businessDate,
          crewId: d.crewId,
          expectedRevision: payload.editedFrom,
          rows: payload.rows,
          note: payload.note,
          occurredAt: now().toISOString(),
        }),
    };
  });
}
