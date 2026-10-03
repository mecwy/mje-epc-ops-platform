import type {
  DeclareStatusCommand,
  ProjectStatus,
  ProjectStatusHistoryDto,
  StatusArea,
} from '@mje/contracts';
import type { ReportApi } from '../api.js';
import { OwnedCommands } from '../field/owned-commands.js';
import { FieldSession } from '../field/session.js';

export interface StatusDraft {
  projectId: string;
  expectedN: number;
  status: ProjectStatus;
  areas: StatusArea[];
  situation: string;
  recovery: string;
  expectedRecoveryDate: string | null;
  expectedRecoveryUnknown: boolean;
  needsSupport: boolean;
  supportNote: string;
  dirty: boolean;
}

type StatusPayload = Omit<DeclareStatusCommand, 'clientMutationId'>;
type StatusApi = Pick<ReportApi, 'projectStatus' | 'declareProjectStatus'>;

function draftFrom(history: ProjectStatusHistoryDto): StatusDraft {
  const latest = history.updates[0];
  return {
    projectId: history.projectId,
    expectedN: history.currentN,
    status: latest?.status ?? 'NORMAL',
    areas: latest ? [...latest.areas] : [],
    situation: latest?.situation ?? '',
    recovery: latest?.recovery ?? '',
    expectedRecoveryDate: latest?.expectedRecoveryDate ?? null,
    expectedRecoveryUnknown: latest?.expectedRecoveryUnknown ?? false,
    needsSupport: latest?.needsSupport ?? false,
    supportNote: latest?.supportNote ?? '',
    dirty: false,
  };
}

function payloadFrom(draft: StatusDraft): StatusPayload {
  return {
    projectId: draft.projectId,
    expectedN: draft.expectedN,
    status: draft.status,
    areas: [...draft.areas],
    situation: draft.situation,
    recovery: draft.recovery,
    expectedRecoveryDate: draft.expectedRecoveryDate,
    expectedRecoveryUnknown: draft.expectedRecoveryUnknown,
    needsSupport: draft.needsSupport,
    supportNote: draft.supportNote,
  };
}

/** One status-command owner per project for the signed-in workspace lifetime. */
export class ProjectStatusSession {
  readonly read: FieldSession<ProjectStatusHistoryDto>;
  readonly commands: OwnedCommands<ProjectStatusHistoryDto, StatusPayload>;
  draft: StatusDraft | null = null;
  activePayload: StatusPayload | null = null;
  lastAttemptMayBeRecorded = false;
  savedNeedsRefresh = false;
  permissionLost = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly api: StatusApi,
    readonly projectId: string,
  ) {
    this.read = new FieldSession(
      () => this.api.projectStatus(this.projectId),
      () => {
        this.syncCleanDraft();
        this.emit();
      },
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

  private syncCleanDraft() {
    const history = this.read.data;
    if (!history || history.projectId !== this.projectId) return;
    if (!this.draft || !this.draft.dirty) this.draft = draftFrom(history);
  }

  async load() {
    await this.read.load();
  }

  edit(patch: Partial<Omit<StatusDraft, 'projectId' | 'expectedN' | 'dirty'>>) {
    if (this.locked || !this.draft || this.draft.projectId !== this.projectId)
      return;
    const next = { ...this.draft, ...patch, dirty: true };
    if (patch.status === 'NORMAL') {
      next.areas = [];
      next.expectedRecoveryDate = null;
      next.expectedRecoveryUnknown = false;
      next.needsSupport = false;
      next.supportNote = '';
    }
    if (patch.expectedRecoveryDate) next.expectedRecoveryUnknown = false;
    if (patch.expectedRecoveryUnknown) next.expectedRecoveryDate = null;
    if (patch.needsSupport === false) next.supportNote = '';
    this.draft = next;
    this.emit();
  }

  get locked() {
    return (
      this.commands.owned ||
      this.read.busy ||
      this.read.error === 'STALE' ||
      this.savedNeedsRefresh ||
      this.permissionLost
    );
  }

  get ownedSnapshot() {
    return this.activePayload ?? (this.draft ? payloadFrom(this.draft) : null);
  }

  async publish() {
    const draft = this.draft;
    if (this.locked || !draft || draft.projectId !== this.projectId) return;
    const payload = payloadFrom(draft);
    // Freeze what the manager saw before OwnedCommands waits for a fresh read.
    this.activePayload = payload;
    this.lastAttemptMayBeRecorded = false;
    this.emit();
    const result = await this.commands.run(payload, (history, key) => {
      if (!history || history.projectId !== this.projectId) return null;
      const command: DeclareStatusCommand = {
        ...payload,
        clientMutationId: key,
      };
      this.activePayload = payload;
      return {
        key,
        send: () => this.api.declareProjectStatus(command),
      };
    });
    this.finish(result);
  }

  async retry() {
    if (this.commands.owned) {
      if (this.commands.unresolved === null) return;
      const result = await this.commands.retry();
      this.finish(result);
      return;
    }
    if (this.savedNeedsRefresh || this.read.error === 'STALE') {
      const refreshingSaved = this.savedNeedsRefresh;
      await this.read.retry();
      if (!this.read.error && !this.read.readError) {
        this.savedNeedsRefresh = false;
        this.activePayload = null;
        // A pre-send read failure did not save the draft. Recovery must not
        // replace its input or move its original expected version.
        if (refreshingSaved) {
          if (this.draft) this.draft = { ...this.draft, dirty: false };
          this.syncCleanDraft();
        }
      }
      this.emit();
      return;
    }
    await this.load();
  }

  async abandon() {
    if (this.commands.unresolved === null || this.read.busy) return;
    this.lastAttemptMayBeRecorded = true;
    this.savedNeedsRefresh = true;
    this.commands.discard();
    await this.read.load();
    if (!this.read.readError) {
      this.savedNeedsRefresh = false;
      this.activePayload = null;
      this.draft = this.read.data ? draftFrom(this.read.data) : null;
    }
    this.emit();
  }

  private finish(
    result:
      | { kind: 'ok'; value: unknown }
      | { kind: 'failed'; code: string }
      | { kind: 'rejected'; code: string; uncertain: boolean; error: unknown },
  ) {
    if (result.kind === 'failed' && this.commands.owned) {
      this.emit();
      return;
    }
    if (result.kind === 'ok') {
      this.lastAttemptMayBeRecorded = false;
      if (this.read.error === 'STALE' || this.read.readError) {
        this.savedNeedsRefresh = true;
      } else {
        this.activePayload = null;
        this.savedNeedsRefresh = false;
        if (this.draft) this.draft = { ...this.draft, dirty: false };
        this.syncCleanDraft();
      }
    } else if (result.kind === 'rejected') {
      this.lastAttemptMayBeRecorded = result.uncertain;
      if (result.code === 'READ_ONLY' || result.code === 'FORBIDDEN')
        this.permissionLost = true;
      const refusedPayload = this.activePayload;
      this.activePayload = null;
      // A refusal is not a saved declaration. Keep the exact submitted input and
      // its original version even if the protected reread has already advanced.
      if (refusedPayload) {
        this.draft = {
          ...refusedPayload,
          areas: [...refusedPayload.areas],
          dirty: true,
        };
      }
    }
    this.emit();
  }
}
