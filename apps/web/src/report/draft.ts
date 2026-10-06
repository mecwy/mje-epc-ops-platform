import type {
  DayFactsDto,
  SaveFactsCommand,
  ReportLocationOperation,
} from '@mje/contracts';
import { ApiError, type WriteResult } from '../api.js';
import { savable, setFact } from './model.js';

export type SaveState =
  'idle' | 'saving' | 'saved' | 'failed' | 'invalid' | 'conflict';
export type FlushOutcome = 'ok' | 'invalid' | 'conflict' | 'failed';
/** An input the user typed that a conflict reload set aside; nothing writes it back by itself. */
export interface Retained {
  path: string;
  mine: string;
}

/** Errors that repeating the same request cannot fix: stop and tell the user. */
const PERMANENT = new Set([
  'READ_ONLY',
  'FORBIDDEN',
  'INVALID_INPUT',
  'NOT_FOUND',
  'IDEMPOTENCY_KEY_REUSED',
  'REQUEST_TOO_LARGE',
]);

// The leaves the user types, by the path grammar of `setFact`. `updated` is a device clock,
// `milestones` and `noWork` are not typed through `setFact`: none of them is retained.
const TOP = ['weather', 'temperature'] as const;
const NARRATIVE = ['construction', 'quality', 'safety'] as const;
const GROUPS = [
  'qty',
  'cumulative',
  'people',
  'presence',
  'machinery',
  'materials',
] as const;

/** The string at a `setFact` path, or undefined where the facts have none. */
export function leaf(facts: DayFactsDto, path: string): string | undefined {
  const [head, key] = path.split('.');
  if (head === 'weather' || head === 'temperature') return facts[head];
  if (head === 'narrative')
    return (NARRATIVE as readonly string[]).includes(key ?? '')
      ? facts.narrative[key as (typeof NARRATIVE)[number]]
      : undefined;
  if ((GROUPS as readonly string[]).includes(head ?? '') && key !== undefined)
    return (facts[head as (typeof GROUPS)[number]] as Record<string, string>)[
      key
    ];
  return undefined;
}

/** The typed leaves whose value differs between two facts. */
export function changedPaths(a: DayFactsDto, b: DayFactsDto): string[] {
  const out: string[] = [];
  for (const k of TOP) if (a[k] !== b[k]) out.push(k);
  for (const k of NARRATIVE)
    if (a.narrative[k] !== b.narrative[k]) out.push(`narrative.${k}`);
  for (const g of GROUPS) {
    const ga = a[g] as Record<string, string>;
    const gb = b[g] as Record<string, string>;
    for (const k of new Set([...Object.keys(ga), ...Object.keys(gb)]))
      if ((ga[k] ?? '') !== (gb[k] ?? '')) out.push(`${g}.${k}`);
  }
  return out;
}

/**
 * The unsaved state of one project day, independent of React and of any other day.
 *
 * - One write at a time; later edits wait and go out as the next write.
 * - A write whose outcome is unknown (network) is kept with its key and resent unchanged
 *   before anything newer, so a response lost after commit replays instead of conflicting.
 * - Conflicts and permanent errors stop the queue; nothing retries in a loop.
 * - `settle()` returns only when everything the user typed is acknowledged, so an action
 *   that follows it acts on exactly what the user sees.
 * - A conflict reload sets the unsaved input aside as `retained`, field by field; the user
 *   fills it in again or ignores it. It is never written back by itself.
 */
export class DraftSession {
  facts: DayFactsDto;
  state: SaveState = 'idle';
  /** Inputs a conflict reload set aside, until filled in again or ignored. */
  retained: Retained[] = [];
  private acked: DayFactsDto;
  private pending: SaveFactsCommand | null = null;
  private locationOperation: ReportLocationOperation | undefined;
  private weatherIntent = false;
  private weatherWritten = false;
  private weatherHadUnknown = false;
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
    return (
      this.facts !== this.acked ||
      this.pending !== null ||
      (this.weatherIntent && !this.weatherWritten)
    );
  }
  get weatherNeedsSave(): boolean {
    return this.weatherIntent;
  }
  get weatherAwaitingRead(): boolean {
    return this.weatherWritten;
  }
  get weatherUnknown(): boolean {
    return (
      this.weatherIntent && this.pending !== null && this.state === 'failed'
    );
  }
  get pendingLocationKind(): ReportLocationOperation['kind'] | null {
    return this.locationOperation?.kind ?? null;
  }
  /** Same draft queue and command as manual facts; raw location never enters facts. */
  editWeather(
    facts: DayFactsDto,
    operation?: ReportLocationOperation,
  ): boolean {
    if (this.frozen || this.pending || this.running || this.weatherWritten)
      return false;
    if (!this.edit(structuredClone(facts))) return false;
    this.locationOperation =
      operation === undefined
        ? this.locationOperation
        : structuredClone(operation);
    this.weatherIntent = true;
    return true;
  }
  get editGeneration(): number {
    return this.generation;
  }
  /**
   * Returns false (and changes nothing) while an action holds the session. Editing a field
   * that has a retained input drops that input: the user has seen the field and decided.
   */
  edit(facts: DayFactsDto): boolean {
    if (this.locked || this.holding) return false;
    if (this.retained.length > 0)
      this.retained = this.retained.filter(
        (r) => leaf(facts, r.path) === leaf(this.facts, r.path),
      );
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
  /**
   * Adopt server state (after a conflict or a finished command). Whatever the user typed but
   * had not saved is set aside as `retained`, field by field, unless the server now holds
   * that very value. An input retained earlier stays until filled in again or ignored.
   */
  reset(version: number, facts: DayFactsDto) {
    const next = new Map(
      this.retained
        .filter((r) => (leaf(facts, r.path) ?? '') !== r.mine)
        .map((r) => [r.path, r] as const),
    );
    for (const path of changedPaths(this.facts, this.acked)) {
      const mine = leaf(this.facts, path) ?? '';
      if ((leaf(facts, path) ?? '') !== mine) next.set(path, { path, mine });
    }
    this.retained = [...next.values()];
    this.version = version;
    this.facts = facts;
    this.acked = facts;
    this.pending = null;
    this.locationOperation = undefined;
    this.weatherIntent = false;
    this.weatherWritten = false;
    this.weatherHadUnknown = false;
    this.blocked = false;
    this.set('idle');
  }

  /** Put a retained input back as an edit of the user's; false while the session is frozen. */
  refill(path: string): boolean {
    const r = this.retained.find((x) => x.path === path);
    if (!r || this.frozen) return false;
    if (leaf(this.facts, path) !== r.mine)
      this.edit(setFact(this.facts, path, r.mine));
    this.dismiss(path);
    return true;
  }
  /** Drop a retained input without writing it. */
  dismiss(path: string) {
    if (!this.retained.some((r) => r.path === path)) return;
    this.retained = this.retained.filter((r) => r.path !== path);
    this.notify();
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
        if (
          this.facts === this.acked &&
          (!this.weatherIntent || this.weatherWritten)
        ) {
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
          facts: this.weatherIntent ? structuredClone(this.facts) : this.facts,
          ...(this.locationOperation === undefined
            ? {}
            : {
                reportLocationOperation: structuredClone(
                  this.locationOperation,
                ),
              }),
        };
        this.pending = command;
      }
      this.set('saving');
      try {
        const result = await this.write(command);
        this.version = result.version;
        this.acked = command.facts;
        if (this.weatherIntent) this.weatherWritten = true;
        // No edit was accepted while a C03 command holds the day.
        if (this.weatherIntent) this.facts = command.facts;
        this.pending = null;
      } catch (error) {
        const code = error instanceof ApiError ? error.code : 'REQUEST_FAILED';
        // The server checks successful replay before CAS/day-state refusal. These two
        // answers therefore settle the original key even after a lost response.
        if (code === 'VERSION_CONFLICT' || code === 'LOCKED') {
          this.pending = null;
          this.set('conflict');
          return 'conflict';
        }
        if (
          this.weatherIntent &&
          (this.weatherHadUnknown ||
            (error instanceof ApiError && error.afterLostAttempt))
        ) {
          // Identity/permission and other pre-replay refusals cannot settle the earlier send.
          this.weatherHadUnknown = true;
          this.set('failed');
          return 'failed';
        }
        if (PERMANENT.has(code)) {
          this.pending = null;
          this.blocked = true;
        } else if (this.weatherIntent) this.weatherHadUnknown = true;
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
