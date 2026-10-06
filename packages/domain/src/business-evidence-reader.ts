/** C05 read exit. Parent supplies its verified report context and immutable FieldDay cut. */
import type { PoolClient } from 'pg';
import type {
  EvidenceTarget,
  EvidenceWorkspace,
  FactEvidence,
  EvidenceCoverage,
  EvidenceBasis,
  EvidencePhotoRef,
} from '@mje/contracts';
import {
  parseBusinessEvidenceManifest,
  parseBusinessEvidenceReceipt,
  parseBusinessEvidenceQuery,
} from '@mje/contracts';
import { projectAccess, transactionSignal } from './store-kit.js';
import type { Actor } from './store-kit.js';
import { dec } from './report-rules.js';
import type { CompletionDeclaration } from './manager-review-rules.js';
import {
  sameCompletionTarget,
  sameEvidenceBasis,
} from './manager-review-rules.js';
import type { BindingPhoto } from './business-evidence-rules.js';
import type {
  BusinessEvidencePorts,
  EvidenceScope,
} from './business-evidence-store.js';
import {
  BusinessEvidenceError,
  authorityAllows,
  mediaMatches,
} from './business-evidence-store.js';

export interface EvidenceVersion {
  id: string;
  daySeq: number;
  evidence: FactEvidence;
  associationCoverage: EvidenceCoverage | null;
}
export type EvidenceReadCut =
  | { kind: 'CURRENT'; writable: boolean }
  | {
      kind: 'FROZEN';
      daySeq: number;
      manifest: { id: string; basis: EvidenceBasis } | null;
    };
export interface BusinessEvidenceReadPorts extends BusinessEvidencePorts {
  /** Parent exit resolves this from its live verified context, never from GET parameters. */
  resolveReadCut(
    client: PoolClient,
    actor: Actor,
    target: EvidenceTarget,
  ): Promise<EvidenceReadCut>;
  listMedia(
    client: PoolClient,
    actor: Actor,
    target: EvidenceTarget,
  ): Promise<readonly (EvidencePhotoRef & { label: string })[]>;
}
export async function readEvidenceVersions(
  client: PoolClient,
  actor: Actor,
  target: EvidenceTarget,
  maxSeq: number | null = null,
): Promise<EvidenceVersion[]> {
  const result = await client.query<{
    id: unknown;
    daySeq: unknown;
    setId: unknown;
    version: unknown;
    coverage: unknown;
    photos: unknown;
    state: unknown;
  }>(
    `SELECT v.id,v."daySeq"::text AS "daySeq",v."setId",v.version,v."coverageJson" AS coverage,v."photosJson" AS photos,v.state FROM "BusinessEvidenceSet" s JOIN "BusinessEvidenceVersion" v ON v."orgId"=s."orgId" AND v."projectId"=s."projectId" AND v."setId"=s.id WHERE s."orgId"=$1 AND s."projectId"=$2 AND s."businessDate"=$3::date AND s."crewId"=$4 AND s."foremanRevisionId"=$5 AND s."itemKey"=$6 AND ($7::bigint IS NULL OR v."daySeq"<=$7) ORDER BY v.version DESC LIMIT 1001`,
    [
      actor.orgId,
      target.projectId,
      target.businessDate,
      target.crewId,
      target.foremanRevisionId,
      target.itemKey,
      maxSeq,
    ],
  );
  // No silent truncation of audit history. Parent can add a paginated exit when needed.
  if (result.rows.length > 1000)
    throw new BusinessEvidenceError('INTEGRATION_REQUIRED');
  return result.rows.map((row) => {
    const parsed = parseBusinessEvidenceManifest({
      target,
      basis: { linkSetId: row.setId, version: row.version },
      coverage: row.coverage,
      photos: row.photos,
      state: row.state,
    });
    const rawSeq = row.daySeq;
    if (
      typeof rawSeq !== 'string' ||
      !/^[1-9][0-9]*$/.test(rawSeq) ||
      BigInt(rawSeq) > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new BusinessEvidenceError('INTEGRATION_REQUIRED');
    const receipt = parseBusinessEvidenceReceipt({
      target,
      basis: parsed.evidence.basis,
      manifestId: row.id,
      daySeq: Number(rawSeq),
      changed: false,
    });
    return { id: receipt.manifestId, daySeq: receipt.daySeq, ...parsed };
  });
}
/** Read projection only. Exact source/containment/media are re-resolved; no synthetic BIND. */
export function projectCurrentEvidence(
  version: EvidenceVersion,
  declaration: CompletionDeclaration,
  scopes: readonly EvidenceScope[],
  media: readonly (BindingPhoto | null)[],
): FactEvidence {
  const evidence = version.evidence;
  const coverage = evidence.coverage;
  const photosAvailable =
    evidence.photos.length > 0 &&
    evidence.photos.every((ref) =>
      media.some(
        (p) =>
          p?.authorized &&
          p.available &&
          p.orgId === declaration.orgId &&
          p.projectId === declaration.target.projectId &&
          p.businessDate === declaration.target.businessDate &&
          p.photoId === ref.photoId &&
          p.photoVersion === ref.photoVersion,
      ),
    );
  if (!photosAvailable) return { ...evidence, state: 'MISSING' };
  const original = dec(declaration.qty);
  const covered = coverage ? dec(coverage.qty) : null;
  const contained =
    coverage !== null &&
    declaration.scopeRef !== null &&
    coverage.withinScopeRef === declaration.scopeRef &&
    scopes.some(
      (s) =>
        s.scopeRef === coverage.scopeRef &&
        s.withinScopeRef === declaration.scopeRef,
    );
  if (declaration.scopeStatus !== 'CONFIRMED' || !declaration.scopeRef)
    return { ...evidence, state: 'UNCONFIRMED_SCOPE' };
  if (!coverage) return { ...evidence, state: 'PARTIAL' };
  if (
    !contained ||
    !declaration.unit?.trim() ||
    coverage?.unit !== declaration.unit ||
    original === null ||
    covered === null ||
    covered > original
  )
    return { ...evidence, state: 'UNCONFIRMED_SCOPE' };
  return {
    ...evidence,
    state:
      coverage.scopeRef === declaration.scopeRef && covered === original
        ? 'READY'
        : 'PARTIAL',
  };
}
export class BusinessEvidenceReader {
  static async read(
    client: PoolClient,
    actor: Actor,
    input: EvidenceTarget,
    ports: BusinessEvidenceReadPorts,
  ): Promise<EvidenceWorkspace> {
    const signal = transactionSignal(client);
    if (!signal || signal.aborted)
      throw new BusinessEvidenceError('INTEGRATION_REQUIRED');
    const target = parseBusinessEvidenceQuery(input);
    const { access } = await projectAccess(client, actor, target.projectId);
    const source = await ports.resolveDeclaration(client, actor, target);
    if (
      !source ||
      source.declaration.orgId !== actor.orgId ||
      !sameCompletionTarget(source.declaration.target, target)
    )
      throw new BusinessEvidenceError('SOURCE_UNAVAILABLE');
    const cut = await ports.resolveReadCut(client, actor, target);
    if (cut.kind === 'CURRENT' && access !== 'write')
      throw new BusinessEvidenceError('FORBIDDEN');
    if (
      cut.kind === 'FROZEN' &&
      (!Number.isSafeInteger(cut.daySeq) || cut.daySeq < 0)
    )
      throw new BusinessEvidenceError('INTEGRATION_REQUIRED');
    const versions = await readEvidenceVersions(
      client,
      actor,
      target,
      cut.kind === 'FROZEN' ? cut.daySeq : null,
    );
    const current =
      cut.kind === 'CURRENT'
        ? (versions[0] ?? null)
        : cut.manifest === null
          ? null
          : (versions.find(
              (v) =>
                v.id === cut.manifest?.id &&
                sameEvidenceBasis(v.evidence.basis, cut.manifest.basis),
            ) ?? null);
    if (cut.kind === 'FROZEN' && cut.manifest && !current)
      throw new BusinessEvidenceError('NOT_FOUND');
    // A parent's absent frozen manifest must not accidentally acquire later/current evidence.
    const visible = current
      ? versions.filter(
          (v) => v.evidence.basis.version <= current.evidence.basis.version,
        )
      : [];
    const scopes = await ports.readScopes(client, actor, target);
    const projections: FactEvidence[] = [];
    for (const version of visible) {
      const media = await Promise.all(
        version.evidence.photos.map((ref) =>
          ports.readMedia(client, actor, target, ref, 'READ'),
        ),
      );
      if (
        version.evidence.photos.some(
          (ref, i) => !mediaMatches(media[i] ?? null, actor, target, ref),
        )
      )
        throw new BusinessEvidenceError('FORBIDDEN');
      // History and submission select a recorded immutable projection. Only the current cut is re-folded.
      projections.push(
        cut.kind === 'CURRENT' && version.id === current?.id
          ? projectCurrentEvidence(version, source.declaration, scopes, media)
          : version.evidence,
      );
    }
    const authority = await ports.resolveAuthority(client, actor, target);
    const canBind =
      cut.kind === 'CURRENT' &&
      cut.writable &&
      access === 'write' &&
      source.currentRevisionNumber === source.declaration.revisionNumber &&
      authorityAllows(authority, actor, target, 'BIND');
    const availablePhotos = canBind
      ? await ports.listMedia(client, actor, target)
      : [];
    for (const ref of availablePhotos) {
      const media = await ports.readMedia(client, actor, target, ref, 'BIND');
      if (!mediaMatches(media, actor, target, ref) || !media.available)
        throw new BusinessEvidenceError('FORBIDDEN');
    }
    return {
      target,
      revisionNumber: source.declaration.revisionNumber,
      declaration: {
        qty: source.declaration.qty,
        unit: source.declaration.unit,
        scopeRef: source.declaration.scopeRef,
      },
      evidence: projections[0] ?? null,
      associationCoverage: current?.associationCoverage ?? null,
      availablePhotos,
      scopes: scopes.map((s) => ({
        id: s.scopeRef,
        withinScopeRef: s.withinScopeRef,
        label: s.label,
      })),
      history: projections.slice(1),
      canBind,
    };
  }
}
