import type {
  MaterialContinuityView,
  AdmitMaterialUseCommand,
  InitializeMaterialScopeCommand,
} from '@mje/contracts';
import type { ReportApi } from '../api.js';
import { FieldSession, type Outcome } from '../field/session.js';
import { OwnedCommands } from '../field/owned-commands.js';
import { DayStore, ownerToken, type DayEntry } from './day-store.js';

type MaterialApi = Pick<
  ReportApi,
  | 'readMaterialContinuity'
  | 'admitMaterialUse'
  | 'initializeMaterialScope'
  | 'issues'
>;
type Action =
  | {
      kind: 'admit';
      payload: Omit<AdmitMaterialUseCommand, 'clientMutationId'>;
    }
  | {
      kind: 'initialize';
      payload: Omit<InitializeMaterialScopeCommand, 'clientMutationId'>;
    };
export class MaterialContinuitySession {
  readonly session: FieldSession<MaterialContinuityView>;
  readonly commands: OwnedCommands<MaterialContinuityView, Action>;
  // Unsaved inputs belong to this project/day session, not a transient report mount.
  readonly openingDraft = {
    quantity: '',
    basis: '',
    ownership: '',
    custody: '',
    location: '',
    date: '',
    cutoff: '',
  };
  openingExpanded = false;
  private readonly listeners = new Set<() => void>();
  private lockOwner: string | null = null;
  private readonly day: DayEntry;
  constructor(
    private readonly api: MaterialApi,
    private readonly store: DayStore,
    readonly projectId: string,
    readonly businessDate: string,
  ) {
    this.day = store.entry(projectId, businessDate);
    this.openingDraft.date = businessDate;
    this.session = new FieldSession(
      () => api.readMaterialContinuity(projectId, businessDate),
      () => {
        for (const f of this.listeners) f();
      },
    );
    this.commands = new OwnedCommands(this.session);
  }
  subscribe = (f: () => void) => {
    this.listeners.add(f);
    return () => {
      this.listeners.delete(f);
    };
  };
  get siteTimezone() {
    return this.day.day?.siteTimezone ?? 'UTC';
  }
  async readFrozen(revisionNumber?: number) {
    return (
      await this.api.readMaterialContinuity(
        this.projectId,
        this.businessDate,
        revisionNumber,
      )
    ).frozen;
  }
  async readFollowups() {
    // Ledger commands link current Issue authority; the report's issue list stays frozen.
    return (
      await this.api.issues(this.projectId, this.businessDate)
    ).issues.filter((i) => i.closedOn === null);
  }
  async load() {
    const ok = await this.session.load();
    if (ok && this.lockOwner && !this.commands.owned && !this.session.pending) {
      if (await this.store.reloadLocked(this.day)) this.lockOwner = null;
    }
    return ok;
  }
  async run(action: Action) {
    if (!this.commands.canStart || this.lockOwner) return false;
    if (
      action.payload.projectId !== this.projectId ||
      ('businessDate' in action.payload &&
        action.payload.businessDate !== this.businessDate)
    )
      return false;
    const owner = ownerToken('material');
    if (!this.store.acquire(this.day, owner)) return false;
    this.lockOwner = owner;
    try {
      const ownedAction = structuredClone(action);
      const outcome = await this.commands.run(ownedAction, (_data, key) => {
        const body = {
          ...structuredClone(ownedAction.payload),
          clientMutationId: key,
        };
        return {
          key,
          send: () =>
            ownedAction.kind === 'admit'
              ? this.api.admitMaterialUse(body as AdmitMaterialUseCommand)
              : this.api.initializeMaterialScope(
                  body as InitializeMaterialScopeCommand,
                ),
        };
      });
      await this.finish(outcome);
      return outcome.kind === 'ok';
    } catch {
      this.session.error = 'NETWORK';
      this.session.changed();
      return false;
    }
  }
  async retry() {
    const outcome = await this.commands.retry();
    await this.finish(outcome);
  }
  async discard() {
    this.commands.discard();
    if (this.lockOwner) {
      await this.store.release(this.day, this.lockOwner, 'unknown');
      if (this.day.lock === null) this.lockOwner = null;
    }
    this.session.changed();
  }
  private async finish(outcome: Outcome<unknown>) {
    if (!this.lockOwner) return;
    if (this.session.pending) return; // Own command/key remains read-only for retry.
    await this.store.release(
      this.day,
      this.lockOwner,
      outcome.kind === 'ok'
        ? 'saved'
        : outcome.kind === 'rejected' && !outcome.uncertain
          ? 'refused'
          : 'unknown',
    );
    if (this.day.lock === null) this.lockOwner = null;
  }
}
const sessions = new WeakMap<
  DayStore,
  Map<string, MaterialContinuitySession>
>();
/** Workspace ownership outlives tabs, roles and the report component. */
export function materialContinuitySession(
  api: MaterialApi,
  store: DayStore,
  projectId: string,
  businessDate: string,
) {
  let days = sessions.get(store);
  if (!days) {
    days = new Map();
    sessions.set(store, days);
  }
  const key = projectId + '@' + businessDate;
  let session = days.get(key);
  if (!session) {
    session = new MaterialContinuitySession(
      api,
      store,
      projectId,
      businessDate,
    );
    days.set(key, session);
  }
  return session;
}
