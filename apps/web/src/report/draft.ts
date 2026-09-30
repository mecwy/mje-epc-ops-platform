import type { DayFactsDto, SaveFactsCommand } from '@mje/contracts';
import { ApiError, type WriteResult } from '../api.js';
import { savable } from './model.js';

export type SaveState =
  'idle' | 'saving' | 'saved' | 'failed' | 'invalid' | 'conflict';
export type FlushOutcome = 'ok' | 'invalid' | 'conflict' | 'failed';

/** Errors that repeating the same request cannot fix: stop and tell the user. */
const PERMANENT = new Set([
  'READ_ONLY',
  'FORBIDDEN',
  'INVALID_INPUT',
  'NOT_FOUND',
  'IDEMPOTENCY_KEY_REUSED',
  'REQUEST_TOO_LARGE',
]);

/**
 * The unsaved state of one project day, independent of React and of any other day.
 *
 * - One write at a time; later edits wait and go out as the next write.
 * - A write whose outcome is unknown (network) is kept with its key and resent unchanged
 *   before anything newer, so a response lost after commit replays instead of conflicting.
 * - Conflicts and permanent errors stop the queue; nothing retries in a loop.
 * - `settle()` returns only when everything the user typed is acknowledged, so an action
 *   that follows it acts on exactly what the user sees.
 */
export class DraftSession {
  facts: DayFactsDto;
  state: SaveState = 'idle';
  private acked: DayFactsDto;
  private pending: SaveFactsCommand | null = null;
  private running: Promise<FlushOutcome> | null = null;
  private blocked = false;
  private generation = 0;
  /** True while an action (submit, correction, no-work) runs: edits are refused. */
  locked = false;
  /** True while a command owned outside the day (a foreman adoption) holds it: edits refused. */
  private holding = false;

  constructor(
    readonly projectId: string,
    readonly businessDate: string,
    public version: number,
    facts: DayFactsDto,
    private readonly write: (command: SaveFactsCommand) => Promise<WriteResult>,
    private readonly notify: () => void,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {
    this.facts = facts;
    this.acked = facts;
  }

  get dirty(): boolean {
    return this.facts !== this.acked || this.pending !== null;
  }
  get editGeneration(): number {
    return this.generation;
  }
  /** Returns false (and changes nothing) while an action holds the session. */
  edit(facts: DayFactsDto): boolean {
    if (this.locked || this.holding) return false;
    this.facts = facts;
    this.generation++;
    this.blocked = false;
    this.set(savable(facts) ? this.state : 'invalid');
    return true;
  }
  /**
   * Take a server read only if it is current: nothing was typed since the read started,
   * nothing is unsaved, and it is not older than what this session already acknowledged.
   */
  adopt(
    read: { version: number; facts: DayFactsDto },
    startedAtGeneration: number,
  ): boolean {
    if (read.version < this.version) return false;
    if (this.dirty || this.generation !== startedAtGeneration || this.running)
      return false;
    this.reset(read.version, read.facts);
    return true;
  }
  /** Adopt server state (after load or a conflict); drops local edits. */
  reset(version: number, facts: DayFactsDto) {
    this.version = version;
    this.facts = facts;
    this.acked = facts;
    this.pending = null;
    this.blocked = false;
    this.set('idle');
  }

  /** Whether edits are refused now (an action or a hold). */
  get frozen(): boolean {
    return this.locked || this.holding;
  }
  /**
   * Hold the day for a command owned outside it (a foreman adoption, C62): edits are refused
   * from this moment, then everything typed is saved. 'ok' leaves the day held until
   * `release()`; anything else frees it at once.
   */
  async hold(): Promise<FlushOutcome> {
    this.holding = true;
    this.notify();
    try {
      const outcome = await this.settle();
      if (outcome !== 'ok') this.release();
      return outcome;
    } catch (err) {
      // Nothing may stay held by a pre-save that threw.
      this.release();
      throw err;
    }
  }
  release() {
    this.holding = false;
    this.notify();
  }

  flush(): Promise<FlushOutcome> {
    if (this.running) return this.running.then(() => this.flush());
    const run = this.run().finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  /** Flush until no edit arrived meanwhile; the outcome describes exactly the visible facts. */
  async settle(): Promise<FlushOutcome> {
    for (;;) {
      const g = this.generation;
      const outcome = await this.flush();
      if (outcome !== 'ok') return outcome;
      if (g === this.generation && !this.dirty) return 'ok';
    }
  }

  private async run(): Promise<FlushOutcome> {
    for (let writes = 0; writes < 20; writes++) {
      let command = this.pending;
      if (!command) {
        if (this.facts === this.acked) {
          if (this.state === 'saving') this.set('saved');
          return 'ok';
        }
        if (this.blocked) return 'failed';
        if (!savable(this.facts)) {
          this.set('invalid');
          return 'invalid';
        }
        command = {
          projectId: this.projectId,
          businessDate: this.businessDate,
          expectedVersion: this.version,
          clientMutationId: this.newId(),
          facts: this.facts,
        };
        this.pending = command;
      }
      this.set('saving');
      try {
        const result = await this.write(command);
        this.version = result.version;
        this.acked = command.facts;
        this.pending = null;
      } catch (error) {
        const code = error instanceof ApiError ? error.code : 'REQUEST_FAILED';
        if (code === 'VERSION_CONFLICT' || code === 'LOCKED') {
          this.pending = null;
          this.set('conflict');
          return 'conflict';
        }
        if (PERMANENT.has(code)) {
          this.pending = null;
          this.blocked = true;
        }
        // Otherwise the outcome is unknown: keep the command and its key for the next attempt.
        this.set('failed');
        return 'failed';
      }
    }
    this.set('failed');
    return 'failed';
  }

  private set(state: SaveState) {
    this.state = state;
    this.notify();
  }
}
