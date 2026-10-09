import type { BusinessEvidenceService } from '@mje/contracts';
import { reportUploadDayState } from './report-lookups.js';
import { nextSeq } from './checkin-store.js';
import { inTransaction, lockReportDay } from './store-kit.js';
/** C05 SQL owner. Foreign facts/media/day sequencing are explicit same-transaction exits. */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  BusinessEvidenceCommand,
  BusinessEvidenceReceipt,
  EvidenceTarget,
  EvidencePhotoRef,
} from '@mje/contracts';
import {
  parseBusinessEvidenceCommand,
  parseBusinessEvidenceReceipt,
} from '@mje/contracts';
import type { Identity } from './alpha-store.js';
import {
  accountTransaction,
  projectWriter,
  idempotent,
  audit,
} from './store-kit.js';
import type { Actor } from './store-kit.js';
import { planEvidenceBinding } from './business-evidence-rules.js';
import type {
  BindingAuthority,
  BindingPhoto,
  BindingCode,
} from './business-evidence-rules.js';
import type { CompletionDeclaration } from './manager-review-rules.js';
import { sameCompletionTarget } from './manager-review-rules.js';
import {
  BusinessEvidenceReader,
  type BusinessEvidenceReadPorts,
  readEvidenceVersions,
  projectCurrentEvidence,
} from './business-evidence-reader.js';

export class BusinessEvidenceError extends Error {
  constructor(
    public readonly code:
      | BindingCode
      | 'LOCKED'
      | 'NOT_FOUND'
      | 'SOURCE_UNAVAILABLE'
      | 'INTEGRATION_REQUIRED'
      | 'IDEMPOTENCY_KEY_REUSED',
  ) {
    super(code);
  }
}
export interface EvidenceDeclarationSource {
  /** Exact source header returned by the foreman owner, never supplied by the client. */
  reportId: string;
  declaration: CompletionDeclaration;
  /** Current source head is separate from the immutable revision the target names. */
  currentRevisionNumber: number;
}
export interface EvidenceScope {
  scopeRef: string;
  withinScopeRef: string;
  label: string;
}
export interface EvidenceDayGate {
  /** Parent field owner rechecks frozen/submitted boundary while its gate is held. */
  assertWritable(): Promise<void>;
  /** Parent owns FieldDay sequence; called only for a changed manifest in this transaction. */
  nextSequence(): Promise<number>;
}
export interface BusinessEvidencePorts {
  resolveAuthority(
    client: PoolClient,
    actor: Actor,
    target: EvidenceTarget,
  ): Promise<BindingAuthority | null>;
  resolveDeclaration(
    client: PoolClient,
    actor: Actor,
    target: EvidenceTarget,
  ): Promise<EvidenceDeclarationSource | null>;
  readMedia(
    client: PoolClient,
    actor: Actor,
    target: EvidenceTarget,
    photo: EvidencePhotoRef,
    purpose: 'BIND' | 'UNBIND' | 'READ',
  ): Promise<BindingPhoto | null>;
  readScopes(
    client: PoolClient,
    actor: Actor,
    target: EvidenceTarget,
  ): Promise<readonly EvidenceScope[]>;
  /** Must use the parent's field day gate on this client, never open another transaction. */
  withDayGate<T>(
    client: PoolClient,
    actor: Actor,
    target: EvidenceTarget,
    work: (gate: EvidenceDayGate) => Promise<T>,
  ): Promise<T>;
}
/** Composition roots must supply real ports. Absence never fabricates grants/media/source/gate. */
export const deniedBusinessEvidencePorts: BusinessEvidencePorts = {
  resolveAuthority: () => Promise.resolve(null),
  resolveDeclaration: () => Promise.resolve(null),
  readMedia: () => Promise.resolve(null),
  readScopes: () => Promise.resolve([]),
  withDayGate: () =>
    Promise.reject(new BusinessEvidenceError('INTEGRATION_REQUIRED')),
};
export function authorityAllows(
  authority: BindingAuthority | null,
  actor: Actor,
  target: EvidenceTarget,
  operation: 'BIND' | 'UNBIND',
): boolean {
  return Boolean(
    authority &&
    authority.orgId === actor.orgId &&
    authority.projectId === target.projectId &&
    authority.crewId === target.crewId &&
    authority.itemKey === target.itemKey &&
    authority.policyRef.trim() &&
    authority.allowed.includes(operation),
  );
}
export function mediaMatches(
  photo: BindingPhoto | null,
  actor: Actor,
  target: EvidenceTarget,
  ref: EvidencePhotoRef,
): photo is BindingPhoto {
  return Boolean(
    photo &&
    photo.authorized &&
    photo.orgId === actor.orgId &&
    photo.projectId === target.projectId &&
    photo.businessDate === target.businessDate &&
    photo.photoId === ref.photoId &&
    photo.photoVersion === ref.photoVersion,
  );
}
export class BusinessEvidenceStore {
  constructor(
    private readonly pool: Pool,
    private readonly ports: BusinessEvidencePorts = deniedBusinessEvidencePorts,
  ) {}
  async write(
    identity: Identity,
    input: BusinessEvidenceCommand,
  ): Promise<BusinessEvidenceReceipt> {
    const command = parseBusinessEvidenceCommand(input);
    return accountTransaction(
      this.pool,
      identity,
      {
        admit: (memberships) =>
          memberships.some((m) => m.role === 'PROJECT_MANAGER'),
        forbidden: () => new BusinessEvidenceError('FORBIDDEN'),
      },
      async (client, actor) => {
        await projectWriter(client, actor, command.target.projectId);
        const authority = await this.ports.resolveAuthority(
          client,
          actor,
          command.target,
        );
        if (
          !authorityAllows(authority, actor, command.target, command.operation)
        )
          throw new BusinessEvidenceError('FORBIDDEN');
        // A removed link can still identify the photo of a successful UNBIND replay. History is immutable.
        let ref: EvidencePhotoRef;
        if (command.operation === 'BIND') ref = command.photo;
        else {
          const versions = await readEvidenceVersions(
            client,
            actor,
            command.target,
          );
          const linked = versions
            .flatMap((v) => v.evidence.photos)
            .find((p) => p.linkId === command.linkId);
          if (!linked) throw new BusinessEvidenceError('LINK_NOT_FOUND');
          ref = linked;
        }
        const admittedMedia = await this.ports.readMedia(
          client,
          actor,
          command.target,
          ref,
          command.operation,
        );
        if (!mediaMatches(admittedMedia, actor, command.target, ref))
          throw new BusinessEvidenceError('FORBIDDEN');
        try {
          return await idempotent(
            client,
            actor,
            'business-evidence',
            command.clientMutationId,
            command,
            () =>
              this.ports.withDayGate(
                client,
                actor,
                command.target,
                async (gate) => {
                  await gate.assertWritable();
                  const source = await this.ports.resolveDeclaration(
                    client,
                    actor,
                    command.target,
                  );
                  if (
                    !source ||
                    source.declaration.orgId !== actor.orgId ||
                    !sameCompletionTarget(
                      source.declaration.target,
                      command.target,
                    )
                  )
                    throw new BusinessEvidenceError('SOURCE_UNAVAILABLE');
                  if (
                    source.currentRevisionNumber !== command.expectedRevision ||
                    source.declaration.revisionNumber !==
                      command.expectedRevision
                  )
                    throw new BusinessEvidenceError('REVISION_CONFLICT');
                  // Re-resolve everything under the shared gate; the pre-replay authorization is not a stale write context.
                  const freshAuthority = await this.ports.resolveAuthority(
                    client,
                    actor,
                    command.target,
                  );
                  if (
                    !authorityAllows(
                      freshAuthority,
                      actor,
                      command.target,
                      command.operation,
                    )
                  )
                    throw new BusinessEvidenceError('FORBIDDEN');
                  const freshMedia = await this.ports.readMedia(
                    client,
                    actor,
                    command.target,
                    ref,
                    command.operation,
                  );
                  if (!mediaMatches(freshMedia, actor, command.target, ref))
                    throw new BusinessEvidenceError('FORBIDDEN');
                  const versions = await readEvidenceVersions(
                    client,
                    actor,
                    command.target,
                  );
                  const current = versions[0] ?? null;
                  const scopes = await this.ports.readScopes(
                    client,
                    actor,
                    command.target,
                  );
                  const currentPhotos = await Promise.all(
                    (current?.evidence.photos ?? []).map((p) =>
                      this.ports.readMedia(
                        client,
                        actor,
                        command.target,
                        p,
                        'READ',
                      ),
                    ),
                  );
                  const photo =
                    command.operation === 'BIND'
                      ? await this.ports.readMedia(
                          client,
                          actor,
                          command.target,
                          command.photo,
                          'BIND',
                        )
                      : null;
                  const result = planEvidenceBinding(command, {
                    declaration: source.declaration,
                    authority: freshAuthority,
                    current: current
                      ? {
                          ...projectCurrentEvidence(
                            current,
                            source.declaration,
                            scopes,
                            currentPhotos,
                          ),
                          orgId: actor.orgId,
                        }
                      : null,
                    currentCoverage: current?.associationCoverage ?? null,
                    currentPhotos: currentPhotos.filter(
                      (p): p is BindingPhoto => p !== null,
                    ),
                    photo,
                    scopes,
                    newLinkSetId: randomUUID(),
                    newLinkId: randomUUID(),
                  });
                  if (!result.ok) throw new BusinessEvidenceError(result.code);
                  if (!result.changed && current)
                    return {
                      target: command.target,
                      basis: result.evidence.basis,
                      manifestId: current.id,
                      daySeq: current.daySeq,
                      changed: false,
                    };
                  const manifestId = randomUUID();
                  const seq = await gate.nextSequence();
                  if (!Number.isSafeInteger(seq) || seq < 1)
                    throw new BusinessEvidenceError('INTEGRATION_REQUIRED');
                  if (!current)
                    await client.query(
                      `INSERT INTO "BusinessEvidenceSet"(id,"orgId","projectId","businessDate","crewId","foremanReportId","foremanRevisionId","itemKey") VALUES($1,$2,$3,$4::date,$5,$6,$7,$8)`,
                      [
                        result.evidence.basis.linkSetId,
                        actor.orgId,
                        command.target.projectId,
                        command.target.businessDate,
                        command.target.crewId,
                        source.reportId,
                        command.target.foremanRevisionId,
                        command.target.itemKey,
                      ],
                    );
                  await client.query(
                    `INSERT INTO "BusinessEvidenceVersion"(id,"orgId","projectId","setId",version,"coverageJson","photosJson",state,"daySeq","clientMutationId","commandJson","actorAccountId","actorPersonId") VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11::jsonb,$12,$13)`,
                    [
                      manifestId,
                      actor.orgId,
                      command.target.projectId,
                      result.evidence.basis.linkSetId,
                      result.evidence.basis.version,
                      JSON.stringify(result.associationCoverage),
                      JSON.stringify(result.evidence.photos),
                      result.evidence.state,
                      seq,
                      command.clientMutationId,
                      JSON.stringify(command),
                      actor.accountId,
                      actor.personId,
                    ],
                  );
                  await audit(
                    client,
                    actor,
                    {
                      type: 'BusinessEvidenceSet',
                      id: result.evidence.basis.linkSetId,
                      version: result.evidence.basis.version,
                    },
                    command.operation,
                    'EXPLICIT_EVIDENCE_ASSOCIATION',
                    result.previousBasis,
                    result.evidence.basis,
                    command.clientMutationId,
                  );
                  return {
                    target: command.target,
                    basis: result.evidence.basis,
                    manifestId,
                    daySeq: seq,
                    changed: true,
                  };
                },
              ),
            parseBusinessEvidenceReceipt,
          );
        } catch (error) {
          // The private schema contract also makes this route's receipt keys unique per tenant,
          // including no-op commands. A cross-account collision never exposes the other receipt.
          if (
            error instanceof Error &&
            'code' in error &&
            error.code === '23505' &&
            'constraint' in error &&
            error.constraint === 'BusinessEvidenceMutationReceipt'
          )
            throw new BusinessEvidenceError('IDEMPOTENCY_KEY_REUSED');
          throw error;
        }
      },
    );
  }
}

/** Parent day gate/sequence exits, kept in the existing SQL owner. Never opens a second transaction. */
export const businessEvidenceDayGate: BusinessEvidencePorts['withDayGate'] =
  async (client, actor, target, work) => {
    await lockReportDay(
      client,
      actor.orgId,
      target.projectId,
      target.businessDate,
    );
    return work({
      assertWritable: async () => {
        const day = await reportUploadDayState(
          client,
          actor.orgId,
          target.projectId,
          target.businessDate,
        );
        if (day?.state === 'SUBMITTED' && day.correctionReason === null)
          throw new BusinessEvidenceError('LOCKED');
      },
      nextSequence: () =>
        nextSeq(client, actor.orgId, target.projectId, target.businessDate),
    });
  };
export function createBusinessEvidenceService(
  pool: Pool,
  ports: BusinessEvidenceReadPorts,
): BusinessEvidenceService {
  const commands = new BusinessEvidenceStore(pool, ports);
  return {
    read: (identity, target) =>
      inTransaction(pool, identity, async (client, actor) => {
        await lockReportDay(
          client,
          actor.orgId,
          target.projectId,
          target.businessDate,
        );
        return BusinessEvidenceReader.read(client, actor, target, ports);
      }),
    write: (identity, command) => commands.write(identity, command),
  };
}
