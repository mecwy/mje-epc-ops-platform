import {
  parseReviewForemanCommand,
  type CompletionEvidenceDto,
  type CompletionReviewDecisionDto,
  type CompletionReviewStateDto,
  type CompletionReviewEventDto,
  type CompletionReviewTargetDto,
  type ReviewForemanCommand,
} from '../../../../packages/contracts/src/manager-review.js';
import { ApiError } from '../api.js';
import { OwnedCommands } from '../field/owned-commands.js';
import { FieldSession, type Outcome } from '../field/session.js';

export type ReviewScope = Omit<CompletionReviewTargetDto, 'foremanRevisionId'>;
/** Authorized server projection, never inferred from job title or general report write access. */
export interface ManagerReviewRead {
  actorScopeKey: string;
  target: CompletionReviewTargetDto;
  revisionNumber: number;
  reviewVersion: number;
  declaredQty: string;
  /** Authorized business labels; never used as fact identity or permission. */
  labels: { crew: string; item: string; scope: string | null };
  unit: string | null;
  scopeRef: string | null;
  capability: {
    basisRef: string | null;
    actions: readonly CompletionReviewDecisionDto[];
  };
  evidence: CompletionEvidenceDto | null;
  state: CompletionReviewStateDto;
  judgment: CompletionReviewEventDto | null;
}
export interface ManagerReviewService {
  read(scope: ReviewScope): Promise<ManagerReviewRead>;
  write(command: ReviewForemanCommand): Promise<void>;
}
/** Adapt the existing DayStore/DayEntry; this session does not create a second day lock. */
export interface ReviewDayLock {
  /** Canonical DayStore ownership, including locks released by a successful external reload. */
  holds(owner: string): boolean;
  acquire(owner: string): boolean;
  /** DayStore.hold saves dirty report edits under this same owner; unknown keeps the lock. */
  prepare(owner: string): Promise<'ok' | 'blocked' | 'unknown'>;
  abandon(owner: string): void;
  release(
    owner: string,
    outcome: 'saved' | 'refused' | 'unknown',
  ): Promise<boolean>;
}
type WithoutTransport<T> = T extends unknown
  ? Omit<T, 'schemaVersion' | 'clientMutationId'>
  : never;
export type ReviewInput = WithoutTransport<ReviewForemanCommand>;
export interface OwnedReview {
  readonly command: ReviewForemanCommand;
  readonly actorScopeKey: string;
  readonly declaration: {
    readonly qty: string;
    readonly unit: string | null;
    readonly crew: string;
    readonly item: string;
  };
}
function sameScope(a: ReviewScope, b: ReviewScope): boolean {
  return (
    a.projectId === b.projectId &&
    a.businessDate === b.businessDate &&
    a.crewId === b.crewId &&
    a.itemKey === b.itemKey
  );
}
function sameTarget(
  a: CompletionReviewTargetDto,
  b: CompletionReviewTargetDto,
): boolean {
  return sameScope(a, b) && a.foremanRevisionId === b.foremanRevisionId;
}
function lockOutcome(result: Outcome<void>): 'saved' | 'unknown' | 'refused' {
  return result.kind === 'ok'
    ? 'saved'
    : result.kind === 'rejected' && result.uncertain
      ? 'unknown'
      : 'refused';
}
export function reviewCanAct(
  d: ManagerReviewRead | null,
  action: CompletionReviewDecisionDto,
): boolean {
  if (!d?.capability.basisRef?.trim() || !d.capability.actions.includes(action))
    return false;
  if (action !== 'CONFIRM_SCOPE') return true;
  return reviewEvidenceAvailable(d);
}
export function reviewEvidenceAvailable(d: ManagerReviewRead): boolean {
  const e = d.evidence;
  return (
    !!e &&
    sameTarget(e.target, d.target) &&
    e.basis.version > 0 &&
    (e.state === 'READY' || e.state === 'PARTIAL') &&
    !!e.coverage &&
    !!d.scopeRef &&
    e.coverage.withinScopeRef === d.scopeRef &&
    !!d.unit &&
    e.coverage.unit === d.unit &&
    e.photos.length > 0 &&
    e.photos.every(
      (p) =>
        !!p.photoId &&
        !!p.linkId &&
        Number.isSafeInteger(p.photoVersion) &&
        p.photoVersion > 0,
    )
  );
}

/** Show only a server judgment with a usable current evidence cut; availability alone never confirms. */
export function visibleReviewState(
  d: ManagerReviewRead,
): CompletionReviewStateDto {
  if (d.state.status !== 'CONFIRMED_SCOPE') return d.state;
  const j = d.judgment;
  const e = d.evidence;
  if (
    reviewEvidenceAvailable(d) &&
    j?.decision === 'CONFIRM_SCOPE' &&
    j.id === d.state.eventId &&
    j.version === d.reviewVersion &&
    sameTarget(j.target, d.target) &&
    j.evidenceBasis &&
    e &&
    j.evidenceBasis.linkSetId === e.basis.linkSetId &&
    j.evidenceBasis.version === e.basis.version &&
    j.confirmedQty === d.state.confirmedQty &&
    j.confirmedQty !== null &&
    d.state.coverage !== 'NONE' &&
    j.scopeRef === e.coverage?.scopeRef &&
    j.unit === e.coverage?.unit &&
    (d.state.coverage !== 'FULL' ||
      (e.state === 'READY' && j.scopeRef === d.scopeRef)) &&
    j.unit === d.state.unit
  )
    return d.state;
  return {
    ...d.state,
    status: 'REVIEW_REQUIRED',
    coverage: 'NONE',
    confirmedQty: null,
    unit: null,
  };
}

/** Keep one instance per actor and project/day/crew/item in the workspace, outside tabs. */
export class ManagerReviewSession {
  readonly scope: ReviewScope;
  readonly session: FieldSession<ManagerReviewRead>;
  readonly owned: OwnedCommands<ManagerReviewRead, OwnedReview>;
  private listeners = new Set<() => void>();
  private generation = 0;
  private actor: string;
  private capturedKey = '';
  private lockOwner: string | null = null;
  private settling = false;
  lockOutcome: 'saved' | 'refused' | 'unknown' | null = null;
  localError: string | null = null;

  constructor(
    scope: ReviewScope,
    actorScopeKey: string,
    private readonly service: ManagerReviewService,
    private readonly day: ReviewDayLock,
    private readonly newKey: () => string = () => crypto.randomUUID(),
  ) {
    this.scope = Object.freeze({ ...scope });
    this.actor = actorScopeKey;
    this.session = new FieldSession(
      async () => {
        const d = await service.read(this.scope);
        if (
          d.actorScopeKey !== this.actor ||
          !sameScope(d.target, this.scope) ||
          !sameTarget(d.state.target, d.target) ||
          d.state.reviewVersion !== d.reviewVersion
        )
          throw new ApiError('TARGET_CHANGED', 409);
        return structuredClone(d);
      },
      () => this.changed(),
    );
    this.owned = new OwnedCommands(this.session, () => this.capturedKey);
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.generation;
  private changed() {
    this.generation++;
    for (const l of this.listeners) l();
  }
  get data() {
    return this.session.readError ? null : this.session.data;
  }
  get held() {
    return this.lockOwner !== null && this.day.holds(this.lockOwner);
  }
  get busy() {
    return this.session.busy || this.settling;
  }
  get canStart() {
    return (
      !this.held &&
      !this.settling &&
      this.owned.canStart &&
      !!this.data &&
      this.data.actorScopeKey === this.actor
    );
  }
  /** Account changes retain the original payload; it cannot be sent under another actor. */
  setActor(actorScopeKey: string) {
    if (this.actor === actorScopeKey) return;
    this.actor = actorScopeKey;
    this.localError = 'ACTOR_CHANGED';
    this.changed();
  }
  async load() {
    return this.session.load();
  }
  private reject(code: string): Outcome<void> {
    this.localError = code;
    this.changed();
    return { kind: 'rejected', code, error: null, uncertain: false };
  }
  async start(input: ReviewInput): Promise<Outcome<void>> {
    if (!this.canStart)
      return this.reject(this.held || this.owned.owned ? 'BUSY' : 'STALE');
    let command: ReviewForemanCommand;
    try {
      command = parseReviewForemanCommand({
        ...input,
        schemaVersion: 1,
        clientMutationId: this.newKey(),
      });
    } catch {
      return this.reject('INVALID_INPUT');
    }
    const initial = this.data!;
    if (!sameScope(command.target, this.scope))
      return this.reject('TARGET_CHANGED');
    if (!reviewCanAct(initial, command.decision))
      return this.reject('FORBIDDEN');
    Object.freeze(command.target);
    if (command.coverage) Object.freeze(command.coverage);
    if (command.evidenceBasis) Object.freeze(command.evidenceBasis);
    Object.freeze(command);
    const action = Object.freeze({
      command,
      actorScopeKey: this.actor,
      declaration: Object.freeze({
        qty: initial.declaredQty,
        unit: initial.unit,
        crew: initial.labels.crew,
        item: initial.labels.item,
      }),
    });
    const key = command.clientMutationId;
    if (!this.day.acquire(key)) return this.reject('BUSY');
    this.lockOwner = key;
    this.capturedKey = key;
    this.localError = null;
    let attempted = false;
    let result: Outcome<void>;
    try {
      result = await this.owned.run(action, (d) => {
        if (
          !d ||
          d.actorScopeKey !== action.actorScopeKey ||
          this.actor !== action.actorScopeKey
        )
          throw new ApiError('ACTOR_CHANGED', 409);
        if (
          !sameTarget(d.target, command.target) ||
          d.revisionNumber !== command.expectedRevision
        )
          throw new ApiError('FOREMAN_REVISION_CHANGED', 409);
        if (d.reviewVersion !== command.expectedVersion)
          throw new ApiError('REVIEW_VERSION_CONFLICT', 409);
        if (!reviewCanAct(d, command.decision))
          throw new ApiError('FORBIDDEN', 403);
        if (
          command.evidenceBasis &&
          (!d.evidence ||
            command.evidenceBasis.linkSetId !== d.evidence.basis.linkSetId ||
            command.evidenceBasis.version !== d.evidence.basis.version)
        )
          throw new ApiError('EVIDENCE_CHANGED', 409);
        return {
          key,
          send: async () => {
            attempted = true;
            const prepared = await this.day.prepare(key);
            if (prepared !== 'ok')
              throw new ApiError(
                prepared === 'unknown' ? 'NETWORK' : 'READ_ONLY',
                409,
              );
            if (this.actor !== action.actorScopeKey)
              throw new ApiError('ACTOR_CHANGED', 409);
            return this.service.write(command);
          },
        };
      });
    } catch (e) {
      if (!attempted) {
        this.day.abandon(key);
        this.lockOwner = null;
        return this.reject(e instanceof ApiError ? e.code : 'REQUEST_FAILED');
      }
      // FieldSession normally contains transport errors; retain the lock on an unexpected throw.
      this.localError = 'REQUEST_FAILED';
      this.changed();
      throw e;
    }
    if (!attempted) {
      this.day.abandon(key);
      this.lockOwner = null;
      this.changed();
    } else if (!this.session.pending) await this.release(lockOutcome(result));
    return result;
  }
  async retry(): Promise<Outcome<void>> {
    const action = this.owned.current;
    if (!action || !this.session.pending || this.busy)
      return this.reject('NOT_FOUND');
    if (this.actor !== action.actorScopeKey)
      return this.reject('ACTOR_CHANGED');
    const result = await this.owned.retry<void>();
    if (!this.session.pending) await this.release(lockOutcome(result));
    return result;
  }
  /** Giving up is not proof of failure. Existing day release rereads before unlocking. */
  async discard() {
    if (this.busy || !this.owned.unresolved) return;
    this.owned.discard();
    await this.release('unknown');
  }
  async refresh() {
    if (this.busy) return false;
    await this.session.load();
    if (this.lockOwner && !this.owned.owned && this.lockOutcome)
      return this.release(this.lockOutcome);
    return !this.session.readError;
  }
  private async release(
    outcome: 'saved' | 'refused' | 'unknown',
  ): Promise<boolean> {
    const key = this.lockOwner;
    if (!key) return true;
    if (!this.day.holds(key)) {
      this.lockOwner = null;
      this.lockOutcome = null;
      this.changed();
      return true;
    }
    this.settling = true;
    this.lockOutcome = outcome;
    this.changed();
    try {
      const released = await this.day.release(key, outcome);
      if (released) {
        this.lockOwner = null;
        this.lockOutcome = null;
      }
      return released;
    } catch {
      this.localError = 'STALE';
      return false;
    } finally {
      this.settling = false;
      this.changed();
    }
  }
}
