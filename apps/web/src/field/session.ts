import { ApiError } from '../api.js';

/**
 * Outcomes that are not a decision about the command: the request may or may not have
 * committed (network, gateway, 5xx), or the server asks for the same request again (RETRY,
 * RATE_LIMITED). The command is kept with its key and resent unchanged by retry().
 */
export const UNSETTLED = new Set([
  'NETWORK',
  'REQUEST_FAILED',
  'RETRY',
  'RATE_LIMITED',
]);

/** Codes by which the server says this device token is no longer a device. */
export const ENDED = new Set(['DEVICE_ENDED', 'FIELD_AUTH_REQUIRED']);

/** A command as it is sent: the key and event are fixed when it is built. */
export interface Command<R> {
  key: string;
  send: () => Promise<R>;
}
export type Outcome<R> =
  | { kind: 'ok'; value: R }
  | { kind: 'rejected'; code: string; error: unknown }
  | { kind: 'failed'; code: string };

/**
 * Field and PM command state, written the IssueSession way (AGENTS.md; issue-session.ts):
 * commands run one at a time from a queue; each is built when it runs, from the newest read;
 * an unsettled command is kept with its key and resent unchanged by retry(); after a write,
 * the next command waits until a read started after that write has landed. Reads are
 * ticketed: an older response, successful or failed, never overwrites a newer one; freshness
 * after a write counts successful reads only. A command refused because the device ended is
 * reported through `onEnded`, so the device page ends even when the refusal came from a
 * command rather than a read. An ended device stays ended: once a read or end() has said so,
 * no later read (a network failure on resume, say) replaces that state, and none is sent.
 */
export class FieldSession<D> {
  data: D | null = null;
  /** The code of the last failed read (reads only; commands report through `error`). */
  readError: string | null = null;
  busy = false;
  /** Last definite refusal, an unsettled code while `pending`, or 'STALE' (no fresh read). */
  error: string | null = null;
  pending: (Command<unknown> & { reread: boolean }) | null = null;
  private reads = 0;
  /** Ticket of the newest response applied (success or failure). */
  private applied = 0;
  /** Ticket of the newest successful read applied. */
  private dataAt = 0;
  private writtenAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  /** The code by which this device ended, latched for the life of this session. */
  private endedCode: string | null = null;

  constructor(
    private readonly read: () => Promise<D>,
    private readonly notify: () => void,
    private readonly options: { onEnded?: (code: string) => void } = {},
  ) {}

  async load(): Promise<boolean> {
    if (this.endedCode) {
      this.notify();
      return false;
    }
    const ticket = ++this.reads;
    try {
      const d = await this.read();
      // Nothing read after the device ended (by an earlier or overlapping read) is applied.
      if (this.endedCode || ticket <= this.applied) return false;
      this.applied = ticket;
      this.dataAt = ticket;
      this.data = d;
      this.readError = null;
      return true;
    } catch (e) {
      if (this.endedCode || ticket <= this.applied) return false;
      this.applied = ticket;
      const code = e instanceof ApiError ? e.code : 'REQUEST_FAILED';
      if (ENDED.has(code)) this.endedCode = code;
      this.readError = code;
      return false;
    } finally {
      this.notify();
    }
  }

  /** True once a read started after the last write has been applied (bounded rereads). */
  private async fresh(): Promise<boolean> {
    for (let i = 0; i < 3 && this.dataAt <= this.writtenAt; i++)
      await this.load();
    return this.dataAt > this.writtenAt;
  }

  /**
   * The device has ended (a command, or another view, was refused with DEVICE_ENDED): record it
   * as the newest reading, so no older response still in flight can bring the device back.
   */
  end(code: string) {
    this.applied = ++this.reads;
    this.endedCode ??= code;
    this.readError = this.endedCode;
    this.notify();
  }

  get needsRetry() {
    return this.pending !== null || this.error === 'STALE';
  }

  /** Resend the kept command unchanged, or reload after a write whose reread failed. */
  retry<R>(): Promise<Outcome<R>> {
    return this.enqueue(async () => {
      const p = this.pending;
      if (p) return this.send(p as Command<R>, p.reread);
      if (!(await this.fresh())) return { kind: 'failed', code: 'STALE' };
      if (this.error === 'STALE') this.error = null;
      this.notify();
      return { kind: 'failed', code: 'RELOADED' };
    });
  }

  /** Drop a kept command the user no longer wants (it may still have been stored). */
  discard() {
    this.pending = null;
    this.error = null;
    this.notify();
  }

  /**
   * Run a command built from the newest data. `build` returns null when the target is not
   * loaded; nothing is sent then. `reread` false: the command's result replaces a reread
   * (for commands whose effect no read shows).
   */
  act<R>(
    build: (data: D | null) => Command<R> | null,
    reread = true,
  ): Promise<Outcome<R>> {
    return this.enqueue(async () => {
      if (this.pending) {
        this.notify();
        return { kind: 'failed', code: this.error ?? 'NETWORK' };
      }
      if (!(await this.fresh())) {
        this.error = 'STALE';
        this.notify();
        return { kind: 'failed', code: 'STALE' };
      }
      const command = build(this.data);
      if (!command) {
        this.error = 'NOT_FOUND';
        this.notify();
        return { kind: 'rejected', code: 'NOT_FOUND', error: null };
      }
      return this.send(command, reread);
    });
  }

  private async send<R>(c: Command<R>, reread: boolean): Promise<Outcome<R>> {
    this.pending = { key: c.key, send: c.send, reread };
    this.busy = true;
    this.error = null;
    this.notify();
    try {
      const value = await c.send();
      this.pending = null;
      if (reread) {
        this.writtenAt = this.reads;
        if (!(await this.fresh())) this.error = 'STALE';
      }
      return { kind: 'ok', value };
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'REQUEST_FAILED';
      if (UNSETTLED.has(code)) {
        this.error = code;
        return { kind: 'failed', code };
      }
      this.pending = null;
      this.error = code;
      if (ENDED.has(code)) this.options.onEnded?.(code);
      if (reread) {
        // A refusal may mean the view is old (a conflict): the next command waits for a reread.
        this.writtenAt = this.reads;
        await this.fresh();
      }
      return { kind: 'rejected', code, error: e };
    } finally {
      this.busy = false;
      this.notify();
    }
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
