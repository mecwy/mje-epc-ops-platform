import type {
  CrewItemStatusDto,
  ForemanAdoptCommand,
  ForemanBasisDto,
  ForemanTotalStatusDto,
} from '@mje/contracts';
import type { ForemanDayView } from '../api.js';
import { OwnedCommands } from '../field/owned-commands.js';
import { FieldSession, type Outcome } from '../field/session.js';

export interface ForemanItemView {
  status: ForemanTotalStatusDto;
  value: string | null;
  atLeast: string | null;
  crews: {
    crewId: string;
    name: string;
    hasForeman: boolean;
    status: CrewItemStatusDto;
    qty: string | null;
  }[];
  /** The latest adoption of this item, if any. */
  adopted: { value: string; at: string; afterSubmission: boolean } | null;
}

/**
 * The foreman claims for one work item beside the PM's figure (design §4, C35, C37): the
 * total's completeness and each expected crew's status, in the crew order of the day.
 */
export function itemView(
  f: ForemanDayView,
  itemKey: string,
): ForemanItemView | null {
  const it = f.items[itemKey];
  if (!it) return null;
  const last = [...f.adoptions]
    .filter((a) => a.itemKey === itemKey)
    .sort((a, b) => b.daySeq - a.daySeq)[0];
  return {
    status: it.status,
    value: it.value,
    atLeast: it.atLeast,
    crews: f.expectedCrews.map((c) => ({
      crewId: c.crewId,
      name: c.name,
      hasForeman: c.hasForeman,
      status: it.crews[c.crewId]?.status ?? 'MISSING_REPORT',
      qty: it.crews[c.crewId]?.qty ?? null,
    })),
    adopted: last
      ? {
          value: last.value,
          at: last.at,
          afterSubmission:
            (last as { afterSubmission?: boolean }).afterSubmission ?? false,
        }
      : null,
  };
}

/** Whether two bases name the same roster version, expected crews and latest revisions. */
export function sameBasis(a: ForemanBasisDto, b: ForemanBasisDto): boolean {
  const crews = (x: ForemanBasisDto) => [...x.expectedCrews].sort().join(',');
  const revs = (x: ForemanBasisDto) =>
    [...x.revisions]
      .map((r) => `${r.crewId}:${r.n ?? '-'}`)
      .sort()
      .join(',');
  return (
    a.rosterVersion === b.rosterVersion &&
    crews(a) === crews(b) &&
    revs(a) === revs(b)
  );
}

export type AdoptBlock = 'readOnly' | 'notComplete' | 'locked' | null;
/** Adoption is explicit, by a writer, of a COMPLETE total, on a day open for facts. */
export function adoptBlock(
  view: ForemanItemView,
  o: { canWrite: boolean; dayState: string },
): AdoptBlock {
  if (!o.canWrite) return 'readOnly';
  if (view.status !== 'COMPLETE' || view.value === null) return 'notComplete';
  if (o.dayState === 'submitted') return 'locked';
  return null;
}

/** An adoption as sent: the item and the basis and total the PM saw. */
export interface AdoptAction {
  item: string;
  basis: ForemanBasisDto;
  value: string;
  expectedVersion: number;
}
export interface AdoptContext {
  api: { adoptForeman: (c: ForemanAdoptCommand) => Promise<unknown> };
  projectId: string;
  businessDate: string;
  /**
   * Hold the day for the adoption (useDay `hold`): everything typed is saved first, then the
   * day's facts are read-only until `release`. Anything but 'ok' stops the adoption (the day
   * is then free again).
   */
  hold: () => Promise<string>;
  /** The newest foreman view and day version (after the hold's save). */
  current: () => { foreman: ForemanDayView | null; version: number } | null;
  /** Read the day again (facts, version, foreman view) and free it for editing. */
  release: () => Promise<unknown>;
}
export type AdoptResult =
  | Outcome<unknown>
  /** The total or its basis changed before sending: shown, nothing sent. */
  | { kind: 'changed' };

/**
 * The PM's explicit adoption of a COMPLETE foreman total (design §4, C36). It adopts exactly
 * the total the PM saw: if the basis or total changed (before sending, or answered
 * FOREMAN_TOTAL_CHANGED), nothing is adopted and the item shows the new total next to the
 * one seen, until the PM adopts again. A lost answer is resent unchanged (same key).
 */
export class AdoptFlow {
  readonly owned: OwnedCommands<null, AdoptAction>;
  /** item → the total the PM saw when it changed under them. */
  changed: Record<string, string | null> = {};
  /**
   * The adoption before its command exists (saving typed facts, holding the day) and after it
   * is answered (the day read again): owned for the whole lifecycle, so nothing else starts
   * and the day stays read-only until the refresh has landed.
   */
  phase: { item: string; value: string } | null = null;

  constructor(
    private readonly ctx: AdoptContext,
    private readonly notify: () => void,
    newKey?: () => string,
  ) {
    this.owned = new OwnedCommands(
      new FieldSession<null>(async () => null, notify),
      newKey,
    );
  }
  /** A new adoption may start only when nothing is running, unresolved or settling. */
  get canStart(): boolean {
    return this.owned.canStart && this.phase === null;
  }
  /** The item and total being adopted (any stage), if any. */
  get active(): { item: string; value: string } | null {
    return this.owned.current ?? this.phase;
  }
  private setPhase(p: { item: string; value: string } | null) {
    this.phase = p;
    this.notify();
  }

  async adopt(
    item: string,
    shown: { basis: ForemanBasisDto; value: string },
  ): Promise<AdoptResult> {
    if (!this.canStart) return { kind: 'failed', code: 'BUSY' };
    // Owned from the first moment: the save of typed facts and the hold are part of it.
    this.setPhase({ item, value: shown.value });
    try {
      const held = await this.ctx.hold();
      if (held !== 'ok')
        return {
          kind: 'failed',
          code: held === 'conflict' ? 'VERSION_CONFLICT' : 'STALE',
        };
      const now = this.ctx.current();
      const live = now?.foreman?.items[item];
      if (
        !now?.foreman ||
        !live ||
        live.value !== shown.value ||
        !sameBasis(now.foreman.basis, shown.basis)
      ) {
        this.changed = { ...this.changed, [item]: shown.value };
        await this.ctx.release();
        return { kind: 'changed' };
      }
      return await this.send(item, shown, now.version);
    } finally {
      this.setPhase(null);
    }
  }
  private async send(
    item: string,
    shown: { basis: ForemanBasisDto; value: string },
    version: number,
  ): Promise<AdoptResult> {
    delete this.changed[item];
    const action: AdoptAction = {
      item,
      basis: shown.basis,
      value: shown.value,
      expectedVersion: version,
    };
    return this.settle(
      action,
      await this.owned.run(
        action,
        (_d, key) => {
          // Fixed once: a Retry under this key sends the same body (AGENTS.md).
          const command: ForemanAdoptCommand = {
            projectId: this.ctx.projectId,
            businessDate: this.ctx.businessDate,
            clientMutationId: key,
            item,
            expectedVersion: action.expectedVersion,
            basis: action.basis,
          };
          return { key, send: () => this.ctx.api.adoptForeman(command) };
        },
        false,
      ),
    );
  }
  /** Resend the unresolved adoption unchanged (the day stays held meanwhile). */
  async retry(): Promise<AdoptResult> {
    const a = this.owned.unresolved;
    if (!a) return { kind: 'failed', code: 'NOT_FOUND' };
    try {
      return await this.settle(a, await this.owned.retry());
    } finally {
      this.setPhase(null);
    }
  }
  /** Give up the unresolved adoption (it may still have been applied): read the day, free it. */
  async discard(): Promise<void> {
    const a = this.owned.unresolved;
    if (!a) return;
    this.owned.discard();
    this.setPhase({ item: a.item, value: a.value });
    try {
      await this.ctx.release();
    } finally {
      this.setPhase(null);
    }
  }

  /**
   * One settlement for a first send and a Retry: an unanswered adoption keeps the day held
   * (read-only) for its Retry; any answer reads the day again, still owned, then frees it.
   */
  private async settle(
    a: AdoptAction,
    r: Outcome<unknown>,
  ): Promise<AdoptResult> {
    if (r.kind === 'failed' && this.owned.current) return r;
    this.setPhase({ item: a.item, value: a.value });
    if (r.kind === 'rejected' && r.code === 'FOREMAN_TOTAL_CHANGED')
      this.changed = { ...this.changed, [a.item]: a.value };
    await this.ctx.release();
    return r;
  }
}
