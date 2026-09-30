import type { Command, FieldSession, Outcome } from './session.js';

/**
 * Commands on one FieldSession, each owned by the action that started it (which device,
 * which decision, which values). Ownership is taken synchronously when an action starts,
 * before any wait for a fresh read, and it is bound to the command's key:
 *
 * - while an action runs or its command is unresolved, no other action can start;
 * - an action that finds another command pending never claims it;
 * - `unresolved` is the action whose own key is pending, so what a Retry is shown for is
 *   exactly what it resends.
 */
export class OwnedCommands<D, A> {
  private owner: { action: A; key: string } | null = null;
  /** Moves every time ownership ends: an edit form keyed by it restarts from the latest read. */
  generation = 0;
  /** The last definite refusal of an owned command (shown after the form restarts). */
  refusal: string | null = null;
  /** Whether an earlier attempt of that refused command went unanswered (Outcome.uncertain). */
  refusalUncertain = false;
  /** The action that was refused last (to name it after its form or row has gone). */
  refused: A | null = null;

  constructor(
    readonly session: FieldSession<D>,
    private readonly newKey: () => string = () => crypto.randomUUID(),
  ) {}

  /**
   * The action whose command is kept for an unchanged retry: settled without an answer and
   * not being sent right now.
   */
  get unresolved(): A | null {
    const o = this.owner;
    return o && !this.session.busy && this.session.pending?.key === o.key
      ? o.action
      : null;
  }
  /** The action running or unresolved, if any (what a form must show while it is owned). */
  get current(): A | null {
    return this.owner?.action ?? null;
  }
  /** Whether an action is running or unresolved. */
  get owned(): boolean {
    return this.owner !== null;
  }
  get canStart(): boolean {
    return (
      this.owner === null &&
      this.session.pending === null &&
      !this.session.busy &&
      !this.session.ended
    );
  }

  /** Start an action; `build` makes its command from the newest read and the action's key. */
  async run<R>(
    action: A,
    build: (data: D | null, key: string) => Command<R> | null,
    reread = true,
  ): Promise<Outcome<R>> {
    if (!this.canStart)
      return { kind: 'failed', code: this.session.error ?? 'BUSY' };
    const key = this.newKey();
    // Claimed now, before any await: nothing else can start or adopt this command.
    this.owner = { action, key };
    this.refusal = null;
    this.refusalUncertain = false;
    this.refused = null;
    // Tell the view now: a mounted editor must give way to the owned payload before the
    // wait for a recovery read (which notifies nobody until it lands).
    this.session.changed();
    const r = await this.session.act((data) => build(data, key), reread);
    this.settle(r, key);
    return r;
  }
  /** Resend the unresolved action's own command, unchanged. */
  async retry<R>(): Promise<Outcome<R>> {
    const o = this.owner;
    if (!o || this.session.pending?.key !== o.key)
      return { kind: 'failed', code: 'NOT_FOUND' };
    const r = await this.session.retry<R>();
    this.settle(r, o.key);
    return r;
  }
  /** Give up the unresolved action (it may still have been applied); the data is reread. */
  discard() {
    if (this.session.busy) return;
    this.session.discard();
    this.release();
    void this.session.load();
  }
  private settle(r: Outcome<unknown>, key: string) {
    if (r.kind === 'failed' && this.session.pending?.key === key) return;
    if (r.kind === 'rejected') {
      this.refusal = r.code;
      this.refusalUncertain = r.uncertain;
      this.refused = this.owner?.action ?? null;
    }
    this.release();
  }
  private release() {
    if (this.owner === null) return;
    this.owner = null;
    this.generation++;
    this.session.changed();
  }
}
