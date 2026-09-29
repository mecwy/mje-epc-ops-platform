import type {
  CloseIssueCommand,
  CreateIssueCommand,
  DismissLagCommand,
  EscalationCategory,
  NoteIssueCommand,
  ReplyIssueCommand,
  SetEscalateCommand,
} from '@mje/contracts';
import { ApiError, type IssueItem, type ReportApi } from '../api.js';

type IssueApi = Pick<
  ReportApi,
  | 'issues'
  | 'lag'
  | 'createIssue'
  | 'noteIssue'
  | 'escalateIssue'
  | 'closeIssue'
  | 'reopenIssue'
  | 'replyIssue'
  | 'dismissLag'
>;
export interface NewIssue {
  title: string;
  category: EscalationCategory | '';
  escalate: boolean;
  controlled: boolean;
  workItemKey: string | null;
  dueOn: string | null;
  note: string;
}
type Pending =
  | { kind: 'create'; command: CreateIssueCommand }
  | { kind: 'note'; command: NoteIssueCommand }
  | { kind: 'escalate'; command: SetEscalateCommand }
  | { kind: 'close'; command: CloseIssueCommand }
  | { kind: 'reopen'; command: CloseIssueCommand }
  | { kind: 'reply'; command: ReplyIssueCommand }
  | { kind: 'dismissLag'; command: DismissLagCommand };
export type IssueOutcome = 'ok' | 'failed' | 'rejected';

/** Errors a retry cannot change; anything else leaves the outcome unknown. */
const DEFINITE = new Set([
  'VERSION_CONFLICT',
  'READ_ONLY',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID_INPUT',
  'CATEGORY_REQUIRED',
  'NEEDS_EXPERT',
  'ISSUE_CLOSED',
  'ISSUE_NOT_CLOSED',
  'DATE_BEFORE_CREATED',
  'DATE_BEFORE_CLOSE',
  'DATE_BEFORE_REOPEN',
  'ITEM_NOT_FOUND',
  'OWNER_NOT_FOUND',
  'IDEMPOTENCY_KEY_REUSED',
]);

/**
 * The issues of one project day, kept for the life of the workspace (never shared with
 * another day). Actions run one at a time and are built when they run, with the issue's
 * current version; an action on an issue that is not loaded is refused, never sent with a
 * guessed version. A command whose outcome is unknown (network) is kept with its key and
 * resent unchanged by retry(), so a lost response never creates a second issue or note.
 */
export class IssueSession {
  issues: IssueItem[] | null = null;
  lag: string[] = [];
  busy = false;
  /**
   * Last definite rejection code; 'NETWORK' while a command awaits retry; 'STALE' when the
   * list could not be reloaded after a write (actions wait for a reload); 'CONFLICT_STALE'
   * for a version conflict whose reload failed.
   */
  error: string | null = null;
  pending: Pending | null = null;
  private reads = 0;
  /** Ticket of the newest read applied, and the read count when the last write settled. */
  private applied = 0;
  private writtenAt = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly api: IssueApi,
    readonly projectId: string,
    readonly businessDate: string,
    private readonly notify: () => void,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  async load(): Promise<boolean> {
    const ticket = ++this.reads;
    try {
      const [list, lag] = await Promise.all([
        this.api.issues(this.projectId, this.businessDate),
        this.api.lag(this.projectId, this.businessDate),
      ]);
      if (ticket <= this.applied) return false;
      this.applied = ticket;
      this.issues = list.issues;
      this.lag = lag.suggestions.map((s) => s.workItemKey);
      return true;
    } catch {
      return false;
    } finally {
      this.notify();
    }
  }

  /**
   * True once a read started after the last write has been applied. A read superseded by a
   * newer one is not enough on its own, so this reads again (bounded) until one lands.
   */
  private async fresh(): Promise<boolean> {
    for (let i = 0; i < 3 && this.applied <= this.writtenAt; i++)
      await this.load();
    return this.applied > this.writtenAt;
  }

  private find(id: string) {
    return this.issues?.find((i) => i.id === id) ?? null;
  }

  /** Resend an unresolved command unchanged (same key), or reload a stale list. */
  retry(): Promise<IssueOutcome> {
    return this.enqueue(async () => {
      if (this.pending) return this.send(this.pending);
      if (!(await this.fresh())) return 'failed';
      if (this.error === 'STALE' || this.error === 'CONFLICT_STALE')
        this.error = null;
      this.notify();
      return 'ok';
    });
  }

  /** Whether the user has something to retry: an unsent command or a failed reload. */
  get needsRetry() {
    return (
      this.pending !== null ||
      this.error === 'STALE' ||
      this.error === 'CONFLICT_STALE'
    );
  }

  private async send(p: Pending): Promise<IssueOutcome> {
    this.pending = p;
    this.busy = true;
    this.notify();
    try {
      await this.call(p);
      this.pending = null;
      this.error = null;
      this.writtenAt = this.reads;
      if (!(await this.fresh())) this.error = 'STALE';
      return 'ok';
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'REQUEST_FAILED';
      if (DEFINITE.has(code)) {
        this.pending = null;
        this.writtenAt = this.reads;
        // A conflict is only "reloaded" once the reload has actually landed.
        this.error =
          (await this.fresh()) || code !== 'VERSION_CONFLICT'
            ? code
            : 'CONFLICT_STALE';
        return 'rejected';
      }
      this.error = 'NETWORK';
      return 'failed';
    } finally {
      this.busy = false;
      this.notify();
    }
  }

  private call(p: Pending): Promise<unknown> {
    switch (p.kind) {
      case 'create':
        return this.api.createIssue(p.command);
      case 'note':
        return this.api.noteIssue(p.command);
      case 'escalate':
        return this.api.escalateIssue(p.command);
      case 'close':
        return this.api.closeIssue(p.command);
      case 'reopen':
        return this.api.reopenIssue(p.command);
      case 'reply':
        return this.api.replyIssue(p.command);
      case 'dismissLag':
        return this.api.dismissLag(p.command);
    }
  }

  /** Build the command when it runs; an unresolved earlier command must be retried first. */
  private act(build: () => Pending | null): Promise<IssueOutcome> {
    return this.enqueue(async () => {
      if (this.pending) {
        this.error = 'NETWORK';
        this.notify();
        return 'failed';
      }
      // Never build a command from versions older than the last write's result.
      if (!(await this.fresh())) {
        this.error = 'STALE';
        this.notify();
        return 'failed';
      }
      const p = build();
      if (!p) {
        this.error = 'NOT_FOUND';
        this.notify();
        return 'rejected';
      }
      return this.send(p);
    });
  }

  private versioned(id: string) {
    const issue = this.find(id);
    return issue
      ? {
          issueId: id,
          expectedVersion: issue.version,
          clientMutationId: this.newId(),
        }
      : null;
  }

  create(x: NewIssue) {
    return this.act(() => ({
      kind: 'create',
      command: {
        projectId: this.projectId,
        businessDate: this.businessDate,
        clientMutationId: this.newId(),
        ownerPersonId: null,
        ...x,
      },
    }));
  }
  note(id: string, text: string) {
    return this.act(() => {
      const v = this.versioned(id);
      return v
        ? {
            kind: 'note',
            command: { ...v, businessDate: this.businessDate, text },
          }
        : null;
    });
  }
  escalate(id: string, escalate: boolean, category: EscalationCategory | '') {
    return this.act(() => {
      const v = this.versioned(id);
      return v
        ? { kind: 'escalate', command: { ...v, escalate, category } }
        : null;
    });
  }
  close(id: string) {
    return this.act(() => {
      const v = this.versioned(id);
      return v
        ? { kind: 'close', command: { ...v, businessDate: this.businessDate } }
        : null;
    });
  }
  reopen(id: string) {
    return this.act(() => {
      const v = this.versioned(id);
      return v
        ? { kind: 'reopen', command: { ...v, businessDate: this.businessDate } }
        : null;
    });
  }
  reply(id: string, text: string) {
    return this.act(() =>
      this.find(id)
        ? {
            kind: 'reply',
            command: {
              issueId: id,
              businessDate: this.businessDate,
              clientMutationId: this.newId(),
              text,
            },
          }
        : null,
    );
  }
  dismissLag(workItemKey: string) {
    return this.act(() => ({
      kind: 'dismissLag',
      command: {
        projectId: this.projectId,
        businessDate: this.businessDate,
        workItemKey,
        clientMutationId: this.newId(),
      },
    }));
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
