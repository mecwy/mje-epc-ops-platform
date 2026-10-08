import { ApiError } from '../api.js';
import { ReadFence } from '../read-fence.js';

/**
 * Outcomes that are not a decision about the command: the request may or may not have
 * committed (network, gateway, 5xx), or the server asks for the same request again (RETRY,
 * RATE_LIMITED). The command is kept with its key and resent unchanged by retry().
 */
export const UNSETTLED = new Set([
  'NETWORK',
  'REQUEST_FAILED',
  'SOURCE_UNAVAILABLE',
  'RETRY',
  'RATE_LIMITED',
]);

/**
 * Unsettled codes after which the request may have committed (no answer, or a 5xx that is
 * not RETRY): a later definite refusal of the same command may follow a stored success.
 */
const AMBIGUOUS = new Set(['NETWORK', 'REQUEST_FAILED', 'SOURCE_UNAVAILABLE']);

/** Codes by which the server says this device token is no longer a device. */
export const ENDED = new Set(['DEVICE_ENDED', 'FIELD_AUTH_REQUIRED']);

/** A command as it is sent: the key and event are fixed when it is built. */
export interface Command<R> {
  key: string;
  send: () => Promise<R>;
}
export type Outcome<R> =
  | { kind: 'ok'; value: R }
  | {
      kind: 'rejected';
      code: string;
      error: unknown;
      /**
       * An earlier attempt of this same command (same key and body) went unanswered, so it
       * may already have been stored: a refusal the server makes before replaying a key's
       * stored answer (authority re-checked) does not mean it was never recorded.
       */
      uncertain: boolean;
    }
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
  /** Whether `error` is a refusal that followed an unanswered attempt (Outcome.uncertain). */
  errorUncertain = false;
  pending: (Command<unknown> & { reread: boolean; uncertain: boolean }) | null =
    null;
  /** Read tickets, applied vs superseded, freshness after a write (the shared fence). */
  private readonly fence = new ReadFence();
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
    const ticket = this.fence.begin();
    try {
      const d = await this.read();
      // Nothing read after the device ended (by an earlier or overlapping read) is applied.
      if (this.endedCode || this.fence.settle(ticket, true) !== 'applied')
        return false;
      this.data = d;
      this.readError = null;
      return true;
    } catch (e) {
      if (this.endedCode || this.fence.settle(ticket, false) !== 'applied')
        return false;
      const code = e instanceof ApiError ? e.code : 'REQUEST_FAILED';
      this.readError = code;
      if (ENDED.has(code)) {
        this.endedCode = code;
        // A read of another resource (the foreman report) ends the device page too.
        this.options.onEnded?.(code);
      }
      return false;
    } finally {
      this.notify();
    }
  }

  /** True once a read started after the last write has been applied (bounded rereads). */
  private async fresh(): Promise<boolean> {
    for (let i = 0; i < 3 && !this.fence.fresh; i++) await this.load();
    return this.fence.fresh;
  }

  /**
   * The device has ended (a command, or another view, was refused with DEVICE_ENDED): record it
   * as the newest reading, so no older response still in flight can bring the device back.
   */
  end(code: string) {
    this.fence.supersedeAll();
    this.endedCode ??= code;
    this.readError = this.endedCode;
    this.notify();
  }

  /** Whether this device has ended (latched for the life of this session). */
  get ended(): boolean {
    return this.endedCode !== null;
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

  /** Tell the view that state around this session changed (command ownership). */
  changed() {
    this.notify();
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
        return {
          kind: 'rejected',
          code: 'NOT_FOUND',
          error: null,
          uncertain: false,
        };
      }
      return this.send(command, reread);
    });
  }

  private async send<R>(
    c: Command<R> & { uncertain?: boolean },
    reread: boolean,
  ): Promise<Outcome<R>> {
    const pending = {
      key: c.key,
      send: c.send,
      reread,
      uncertain: c.uncertain ?? false,
    };
    this.pending = pending;
    this.busy = true;
    this.error = null;
    this.errorUncertain = false;
    this.notify();
    try {
      const value = await c.send();
      this.pending = null;
      if (reread) {
        this.fence.wrote();
        if (!(await this.fresh())) this.error = 'STALE';
      }
      return { kind: 'ok', value };
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'REQUEST_FAILED';
      // The transport resent this request after a lost one: that one may have committed.
      const lostBefore =
        (e as { afterLostAttempt?: unknown } | null)?.afterLostAttempt === true;
      if (lostBefore || AMBIGUOUS.has(code)) pending.uncertain = true;
      if (UNSETTLED.has(code)) {
        this.error = code;
        return { kind: 'failed', code };
      }
      this.pending = null;
      this.error = code;
      this.errorUncertain = pending.uncertain;
      // The command's own answer ends the device: latched here, whatever the rereads get.
      if (ENDED.has(code)) {
        this.end(code);
        this.options.onEnded?.(code);
      }
      if (reread) {
        // A refusal may mean the view is old (a conflict): the next command waits for a reread.
        this.fence.wrote();
        await this.fresh();
      }
      return { kind: 'rejected', code, error: e, uncertain: pending.uncertain };
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
