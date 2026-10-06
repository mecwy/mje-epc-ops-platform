import type {
  BusinessEvidenceCommand,
  EvidenceCoverage,
  EvidencePhotoRef,
  EvidenceTarget,
  EvidenceWorkspace,
} from '../../../../packages/contracts/src/business-evidence.js';
import { parseBusinessEvidenceCommand } from '../../../../packages/contracts/src/business-evidence.js';
import { ApiError } from '../api.js';
import { OwnedCommands } from '../field/owned-commands.js';
import { FieldSession, type Outcome } from '../field/session.js';
import { outcomeKey } from '../field/errors.js';

/** The real authorized provider is supplied by the workspace owner; no mock runtime fallback. */
export interface EvidencePort {
  read(target: EvidenceTarget): Promise<EvidenceWorkspace>;
  command(command: BusinessEvidenceCommand): Promise<unknown>;
}
type WithoutKey<T> = T extends unknown ? Omit<T, 'clientMutationId'> : never;
export type EvidenceAction = WithoutKey<BusinessEvidenceCommand>;
const sameTarget = (a: EvidenceTarget, b: EvidenceTarget) =>
  a.projectId === b.projectId &&
  a.businessDate === b.businessDate &&
  a.crewId === b.crewId &&
  a.foremanRevisionId === b.foremanRevisionId &&
  a.itemKey === b.itemKey;
const sameBasis = (
  a: EvidenceWorkspace['evidence'],
  b: EvidenceAction['expectedBasis'],
) =>
  a
    ? b !== null &&
      a.basis.linkSetId === b.linkSetId &&
      a.basis.version === b.version
    : b === null;

/** Keep this owner at workspace lifetime, never inside a tab/project-dependent component. */
export class EvidenceSession {
  readonly target: EvidenceTarget;
  readonly list: FieldSession<EvidenceWorkspace>;
  readonly actions: OwnedCommands<EvidenceWorkspace, EvidenceAction>;
  private readonly listeners = new Set<() => void>();
  constructor(
    target: EvidenceTarget,
    private readonly port: EvidencePort | null,
    newKey?: () => string,
  ) {
    this.target = Object.freeze({ ...target });
    this.list = new FieldSession(
      async () => {
        if (!this.port) throw new ApiError('NOT_CONNECTED', 0);
        const data = await this.port.read(this.target);
        if (
          !sameTarget(data.target, this.target) ||
          (data.evidence && !sameTarget(data.evidence.target, this.target)) ||
          data.history.some((e) => !sameTarget(e.target, this.target))
        )
          throw new ApiError('NOT_FOUND', 404);
        return structuredClone(data);
      },
      () => this.changed(),
    );
    this.actions = new OwnedCommands(this.list, newKey);
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed() {
    for (const listener of this.listeners) listener();
  }
  get connected() {
    return this.port !== null;
  }
  get data(): EvidenceWorkspace | null {
    if (
      this.list.ended ||
      this.list.readError === 'FORBIDDEN' ||
      this.list.readError === 'LOGIN_REQUIRED' ||
      this.list.readError === 'NOT_FOUND'
    )
      return null;
    return this.list.data;
  }
  get canEdit() {
    return (
      this.connected &&
      this.actions.canStart &&
      this.data?.canBind === true &&
      this.list.error !== 'STALE' &&
      this.list.readError === null
    );
  }
  get messageKey() {
    return outcomeKey(this.list.error, {
      write: true,
      uncertain: this.list.errorUncertain,
    });
  }
  load() {
    return this.list.load();
  }
  private base(data: EvidenceWorkspace) {
    return {
      schemaVersion: 1 as const,
      target: { ...data.target },
      expectedRevision: data.revisionNumber,
      expectedBasis: data.evidence ? { ...data.evidence.basis } : null,
    };
  }
  bind(
    photo: EvidencePhotoRef,
    coverage: EvidenceCoverage,
    editedFrom: EvidenceWorkspace,
  ): Promise<Outcome<unknown>> {
    return this.run({
      ...this.base(editedFrom),
      operation: 'BIND',
      photo: { photoId: photo.photoId, photoVersion: photo.photoVersion },
      coverage: { ...coverage },
    });
  }
  unbind(
    linkId: string,
    editedFrom: EvidenceWorkspace,
  ): Promise<Outcome<unknown>> {
    return this.run({ ...this.base(editedFrom), operation: 'UNBIND', linkId });
  }
  private run(input: EvidenceAction): Promise<Outcome<unknown>> {
    if (!this.connected || !this.canEdit)
      return Promise.resolve({
        kind: 'failed',
        code: this.connected ? 'BUSY' : 'NOT_CONNECTED',
      });
    const action = structuredClone(input);
    return this.actions.run(action, (latest, key) => {
      let command: BusinessEvidenceCommand;
      try {
        command = parseBusinessEvidenceCommand({
          ...action,
          clientMutationId: key,
        });
      } catch {
        return {
          key,
          send: () => Promise.reject(new ApiError('INVALID_INPUT', 400)),
        };
      }
      let refusal: string | null = null;
      if (!latest?.canBind) refusal = 'FORBIDDEN';
      else if (
        !sameTarget(action.target, this.target) ||
        !sameTarget(latest.target, action.target)
      )
        refusal = 'NOT_FOUND';
      else if (latest.revisionNumber !== action.expectedRevision)
        refusal = 'REVISION_CONFLICT';
      else if (!sameBasis(latest.evidence, action.expectedBasis))
        refusal = 'VERSION_CONFLICT';
      // A local stale/ownership refusal must not send or rebind the typed payload.
      return {
        key,
        send: refusal
          ? () => Promise.reject(new ApiError(refusal, 409))
          : () => this.port!.command(structuredClone(command)),
      };
    });
  }
  retry() {
    return this.actions.unresolved
      ? this.actions.retry<unknown>()
      : this.list.retry<unknown>();
  }
  discard() {
    this.actions.discard();
  }
}
