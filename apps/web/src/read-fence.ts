/**
 * The read fence, shared by every session that reads server state and writes to it
 * (AGENTS.md: read fences live only here). FieldSession (field and PM commands) and DayStore
 * (report days) use it; nothing else keeps its own tickets.
 *
 * - Every read takes a ticket when it starts (`begin`).
 * - A response is **applied** only if no newer response (success or failure) was applied
 *   before it; otherwise it is **superseded** and changes nothing (`settle`).
 * - After a write, `fresh` is true only once a read that *started after the write* has been
 *   applied successfully **and taken** by the state it feeds (`landed`). A superseded ticket,
 *   or an applied response the local state refused (unsaved edits, say), never counts.
 * - A **barrier** (a day unlocked for editing, say) records the local edit generation: a read
 *   started before the barrier may not overwrite local edits accepted after it (`mayOverwrite`).
 *   The protection is monotonic across successive barriers: once an edit was accepted after a
 *   barrier, reads started before that barrier stay barred for good, whatever later barriers
 *   record (a second lock released while an older read is still in flight, say).
 * - `supersedeAll` fences every read in flight (a device that ended).
 */
export type ReadVerdict = 'applied' | 'superseded';

export class ReadFence {
  private started = 0;
  /** Ticket of the newest response applied (success or failure). */
  private settledAt = 0;
  /** Ticket of the newest successful response applied. */
  private landedAt = 0;
  /** `started` when the last write happened: reads with a higher ticket are fresh. */
  private writtenAt = 0;
  /** The last barrier: reads up to this ticket may not overwrite edits made after it. */
  private barrierTicket = 0;
  private barrierGeneration = 0;
  /**
   * Reads up to this ticket may never overwrite: a barrier they started before was followed by
   * an accepted edit. Only grows.
   */
  private barredUpTo = 0;

  /** A read starts: its ticket. */
  begin(): number {
    return ++this.started;
  }
  /**
   * A response for `ticket` arrives. 'applied' (and recorded) only when no newer response was
   * applied already; the caller applies the data (or the failure) only then. `landed` (default:
   * `ok`) says whether its data actually reached the local state; only then can it make the
   * fence fresh.
   */
  settle(ticket: number, ok: boolean, landed = ok): ReadVerdict {
    if (ticket <= this.settledAt) return 'superseded';
    this.settledAt = ticket;
    if (ok && landed) this.landedAt = ticket;
    return 'applied';
  }
  /** Whether a response for `ticket` would be applied now (without recording it). */
  current(ticket: number): boolean {
    return ticket > this.settledAt;
  }
  /** A write happened: only reads started from now on count as fresh. */
  wrote() {
    this.writtenAt = this.started;
  }
  /** A read started after the last write has been applied successfully. */
  get fresh(): boolean {
    return this.landedAt > this.writtenAt;
  }
  /** Whether any read has been applied successfully yet. */
  get loaded(): boolean {
    return this.landedAt > 0;
  }
  /**
   * Local edits may start now (a lock released, say): reads already started may not
   * overwrite edits accepted after this point.
   */
  barrier(generation: number) {
    // Edits accepted since the previous barrier: reads started before it stay barred.
    if (generation !== this.barrierGeneration)
      this.barredUpTo = Math.max(this.barredUpTo, this.barrierTicket);
    this.barrierTicket = this.started;
    this.barrierGeneration = generation;
  }
  /**
   * Whether a read with `ticket` may overwrite local state whose edit generation is now
   * `generation`: not when it started before the last barrier and something was edited since,
   * and never when it started before an earlier barrier that was followed by an edit.
   */
  mayOverwrite(ticket: number, generation: number): boolean {
    if (ticket <= this.barredUpTo) return false;
    return ticket > this.barrierTicket || generation === this.barrierGeneration;
  }
  /** Fence every read in flight: none of them may be applied any more. */
  supersedeAll() {
    this.settledAt = ++this.started;
  }
}
