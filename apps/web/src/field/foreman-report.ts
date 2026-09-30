import type {
  ChallengeConfirmCommand,
  ChallengeRejectCommand,
  FieldMeDto,
  ForemanReportCommand,
  ForemanReportDto,
} from '@mje/contracts';
import { dec, isToken } from '@mje/domain/rules';
import { shift, siteToday } from '../report/format.js';
import { FieldApiError, type DeviceApi } from './field-api.js';
import { OwnedCommands } from './owned-commands.js';
import { FieldSession, type Outcome } from './session.js';

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

/**
 * A report send as sent: the crew and site day it was typed for, its rows (blanks kept), note
 * and the revision it was edited from. All of them come from the read the draft was edited
 * from; no later read re-binds any of them.
 */
export interface ReportSend {
  crewId: string;
  businessDate: string;
  rows: { itemKey: string; qty: string }[];
  note: string;
  editedFrom: number;
}
/** The payload for rows and a note typed on `data` (the read the form was edited from). */
export function reportPayload(
  data: ForemanReportDto,
  rows: ReportSend['rows'],
  note: string,
): ReportSend {
  return {
    crewId: data.crewId,
    businessDate: data.businessDate,
    rows,
    note,
    editedFrom: data.n,
  };
}

/**
 * Send a report as edited (AGENTS.md: form state = the owned command's payload). The command
 * carries the crew, day and revision the draft was edited for, never ones read later: a stale
 * draft gets REVISION_CONFLICT, and a draft typed for another crew or day (the foreman was
 * moved while a recovery read was pending) is refused on the phone as CREW_CHANGED and never
 * sent. Every field, occurredAt included, is fixed once when the command is built, so a Retry
 * under the same key sends the same body and the server replays the stored answer.
 */
export function sendReport(
  sends: OwnedCommands<ForemanReportDto, ReportSend>,
  api: Pick<DeviceApi, 'submitReport'>,
  payload: ReportSend,
  now: () => Date = () => new Date(),
): Promise<Outcome<unknown>> {
  return sends.run(payload, (d, key) => {
    if (!d) return null;
    if (d.crewId !== payload.crewId || d.businessDate !== payload.businessDate)
      return {
        key,
        send: () => Promise.reject(new FieldApiError('CREW_CHANGED', 0)),
      };
    const command: ForemanReportCommand = {
      clientMutationId: key,
      businessDate: payload.businessDate,
      crewId: payload.crewId,
      expectedRevision: payload.editedFrom,
      rows: payload.rows,
      note: payload.note,
      occurredAt: now().toISOString(),
    };
    return { key, send: () => api.submitReport(command) };
  });
}

/**
 * One site day of the foreman's report, for the card's life: the read, its owned sends and
 * the last refused payload. A first send and a Retry settle through the same path, so a
 * conflict reached either way keeps what was typed for the "you had typed" hints.
 */
export class ReportDay {
  readonly session: FieldSession<ForemanReportDto>;
  readonly sends: OwnedCommands<ForemanReportDto, ReportSend>;
  /**
   * The payload of the last established REVISION_CONFLICT (its "you had typed … not saved"
   * hints are shown beside the latest read). Never set for another refusal, nor for any
   * outcome after an unanswered attempt (`uncertain`): that send may have been recorded.
   */
  refused: ReportSend | null = null;

  constructor(
    private readonly api: Pick<DeviceApi, 'report' | 'submitReport'>,
    readonly day: string,
    private readonly notify: () => void,
    onEnded: (code: string) => void,
    private readonly now: () => Date = () => new Date(),
    newKey?: () => string,
  ) {
    this.session = new FieldSession<ForemanReportDto>(
      () => api.report(day),
      notify,
      { onEnded },
    );
    this.sends = new OwnedCommands(this.session, newKey);
  }
  async send(payload: ReportSend): Promise<Outcome<unknown>> {
    this.refused = null;
    return this.settle(
      payload,
      await sendReport(this.sends, this.api, payload, this.now),
    );
  }
  /** Resend the unresolved send unchanged (same body, same key). */
  async retry(): Promise<Outcome<unknown>> {
    const payload = this.sends.unresolved;
    if (!payload) return { kind: 'failed', code: 'NOT_FOUND' };
    this.refused = null;
    return this.settle(payload, await this.sends.retry());
  }
  discard() {
    this.refused = null;
    this.sends.discard();
  }
  private settle(payload: ReportSend, r: Outcome<unknown>) {
    if (r.kind === 'rejected' && r.code === 'REVISION_CONFLICT' && !r.uncertain)
      this.refused = payload;
    this.notify();
    return r;
  }
}

/**
 * The report days of one card (the site's today and yesterday), kept for the card's life: a
 * day's read and owned send survive switching the day tab away and back.
 */
export class ReportDays {
  private readonly days = new Map<string, ReportDay>();
  constructor(
    private readonly api: Pick<DeviceApi, 'report' | 'submitReport'>,
    private readonly notify: () => void,
    private readonly onEnded: (code: string) => void,
    private readonly now?: () => Date,
    private readonly newKey?: () => string,
  ) {}
  /** The days with a send running or unresolved. */
  owned(): ReportDay[] {
    return this.all().filter((d) => d.sends.current !== null);
  }
  /** Every day read so far (for the owned-actions bar). */
  all(): ReportDay[] {
    return [...this.days.values()];
  }
  get(day: string): ReportDay {
    let d = this.days.get(day);
    if (!d) {
      d = new ReportDay(
        this.api,
        day,
        this.notify,
        this.onEnded,
        this.now,
        this.newKey,
      );
      this.days.set(day, d);
    }
    return d;
  }
}
