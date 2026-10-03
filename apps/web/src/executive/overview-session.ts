import type {
  AddStatusNoteCommand,
  ProjectOverviewDto,
  StatusCommandResultDto,
} from '@mje/contracts';
import { ApiError } from '../api.js';
import { FieldSession, type Outcome } from '../field/session.js';
import { OwnedCommands } from '../field/owned-commands.js';

export interface OverviewApi {
  projectOverview(
    projectId: string,
    statusPage: number,
  ): Promise<ProjectOverviewDto>;
  addProjectStatusNote(
    command: AddStatusNoteCommand,
  ): Promise<StatusCommandResultDto>;
}
type Reply = Readonly<{ projectId: string; n: number; text: string }>;
type Page = { page: number; overview: ProjectOverviewDto };
const DENIED = new Set([
  'FORBIDDEN',
  'NOT_FOUND',
  'READ_ONLY',
  'UNAUTHORIZED',
  'LOGIN_REQUIRED',
]);

/** One instance per authenticated workspace and project, retained across navigation. */
export class ProjectOverviewSession {
  readonly read: FieldSession<Page>;
  readonly commands: OwnedCommands<Page, Reply>;
  page = 1;
  readonly drafts = new Map<number, string>();
  savedN: number | null = null;
  savedNeedsRefresh = false;
  lastAttemptMayBeRecorded = false;
  private permissionDenied = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly api: OverviewApi,
    readonly projectId: string,
  ) {
    this.read = new FieldSession(
      async () => {
        const page = this.page;
        const overview = await api.projectOverview(projectId, page);
        if (
          overview.projectId !== projectId ||
          overview.statusHistory.projectId !== projectId
        )
          throw new ApiError('NOT_FOUND', 404);
        return { page, overview };
      },
      () => this.emit(),
    );
    this.commands = new OwnedCommands(this.read);
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit() {
    for (const listener of this.listeners) listener();
  }
  get permissionLost() {
    return DENIED.has(this.read.readError ?? '') || this.permissionDenied;
  }
  get data(): ProjectOverviewDto | null {
    if (this.permissionLost || this.read.data?.page !== this.page) return null;
    return this.read.data.overview;
  }
  get locked() {
    return (
      this.commands.owned ||
      !this.commands.canStart ||
      this.savedNeedsRefresh ||
      this.permissionLost ||
      !this.data ||
      this.read.readError !== null
    );
  }
  get canNext() {
    return Boolean(
      this.data && this.page * 20 < this.data.statusHistory.currentN,
    );
  }
  get retryable() {
    return this.commands.unresolved !== null;
  }
  get mayBeRecorded() {
    return (
      this.lastAttemptMayBeRecorded ||
      this.commands.refusalUncertain ||
      Boolean(this.read.pending?.uncertain)
    );
  }
  async load() {
    const applied = await this.read.load();
    if (applied && this.read.data?.page === this.page) {
      this.permissionDenied = false;
      this.savedNeedsRefresh = false;
    }
    this.emit();
  }
  async goToPage(page: number) {
    if (
      this.commands.owned ||
      this.read.busy ||
      this.savedNeedsRefresh ||
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > 1_000_000
    )
      return;
    this.page = page;
    this.emit();
    await this.load();
  }
  edit(n: number, text: string) {
    if (
      this.locked ||
      !this.data?.statusHistory.updates.some((update) => update.n === n)
    )
      return;
    this.drafts.set(n, text);
    this.savedN = null;
    this.emit();
  }
  async reply(n: number) {
    const text = this.drafts.get(n) ?? '';
    if (
      this.locked ||
      !text.trim() ||
      text.length > 4000 ||
      !this.data?.statusHistory.updates.some((update) => update.n === n)
    )
      return;
    const payload = Object.freeze({ projectId: this.projectId, n, text });
    const result = await this.commands.run(payload, (data, key) => {
      if (
        data?.page !== this.page ||
        data.overview.projectId !== payload.projectId ||
        !data.overview.statusHistory.updates.some(
          (update) => update.n === payload.n,
        )
      )
        return null;
      // The target is the selected immutable declaration, never the newly read currentN.
      const command: AddStatusNoteCommand = {
        ...payload,
        clientMutationId: key,
      };
      return { key, send: async () => this.api.addProjectStatusNote(command) };
    });
    this.finish(result, payload);
  }
  private finish(result: Outcome<unknown>, payload: Reply) {
    if (result.kind === 'ok') {
      this.savedN = payload.n;
      this.drafts.delete(payload.n);
      this.savedNeedsRefresh = this.read.error === 'STALE';
      this.lastAttemptMayBeRecorded = false;
    } else if (result.kind === 'rejected') {
      this.lastAttemptMayBeRecorded ||= result.uncertain;
      this.permissionDenied = DENIED.has(result.code);
    }
    this.emit();
  }
  async retry() {
    const payload = this.commands.unresolved;
    if (!payload) return;
    const result = await this.commands.retry();
    this.finish(result, payload);
  }
  discard() {
    if (!this.retryable) return;
    this.lastAttemptMayBeRecorded ||= Boolean(this.read.pending?.uncertain);
    this.commands.discard();
    this.emit();
  }
}
