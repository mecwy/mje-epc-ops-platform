import type { Pool, PoolClient } from 'pg';
import type {
  ContractHistoryDto,
  ContractRegisterItemDto,
  ContractRevisionDto,
  ContractLineDto,
  ContractShareDto,
  ContractEditorDto,
  ContractEditorLookupsDto,
} from '@mje/contracts';
import type { Identity } from '../alpha-store.js';
import { accountTransaction, type Actor } from '../store-kit.js';
import { activeGrants } from './grants.js';
import {
  allowsHeader,
  allowsProject,
  maintainsOrganization,
  maintainsProjects,
  ContractRegisterError,
  type ContractGrant,
} from './rules.js';
import {
  identityRow,
  snapshot,
  currentShares,
  type ContractIdentity,
  type Snapshot,
} from './data.js';
import {
  executionChanged,
  validateShares,
  type StoredShare,
} from './validation.js';
export const CONTRACT_PROJECTORS = [
  'contract-register.list',
  'contract-register.detail',
  'contract-register.history',
  'contract-register.editor',
  'contract-register.lookups',
] as const;
let observer: ((name: (typeof CONTRACT_PROJECTORS)[number]) => void) | null =
  null;
export function observeContractProjections(next: typeof observer) {
  if (next && process.env['NODE_ENV'] !== 'test')
    throw new Error('test-only observer');
  observer = next;
}
function projected<T>(name: (typeof CONTRACT_PROJECTORS)[number], value: T): T {
  try {
    observer?.(name);
  } catch {
    /* observation is not authorization */
  }
  return value;
}
function revision(
  row: ContractIdentity,
  s: Snapshot,
  g: ContractGrant[],
  all: StoredShare[],
): ContractRevisionDto {
  const r = s.revision;
  const amount = allowsHeader(g, 'contract.amount', row.direction);
  const orgView = allowsHeader(g, 'contract.view', row.direction);
  const lines: ContractLineDto[] = r.lines
    .filter(
      (l) =>
        orgView ||
        all.some(
          (p) =>
            p.pinnedLine.id === l.id &&
            !p.retired &&
            allowsProject(g, 'contract.view', row.direction, p.projectId),
        ),
    )
    .map((l) => {
      const shares = all.filter((p) => p.pinnedLine.id === l.id);
      const active = shares.filter((p) => !p.retired);
      const lineAllows = (
        cap: 'contract.amount' | 'contract.terms' | 'contract.internal',
      ) =>
        allowsHeader(g, cap, row.direction) ||
        active.some(
          (p) =>
            allowsProject(g, 'contract.view', row.direction, p.projectId) &&
            allowsProject(g, cap, row.direction, p.projectId),
        );
      const canAmount = lineAllows('contract.amount');
      const internal = canAmount && lineAllows('contract.internal');
      let allocation: ContractLineDto['allocation'] = {
        state: 'RESTRICTED',
        remaining: null,
      };
      if (orgView) {
        if (active.some((p) => executionChanged(p.pinnedLine, l)))
          allocation = { state: 'RECONCILE', remaining: null };
        else
          try {
            allocation = validateShares(l, shares, []);
          } catch {
            allocation = { state: 'RECONCILE', remaining: null };
          }
      }
      return {
        id: l.id,
        lineNo: l.lineNo,
        description: l.description,
        quantity: { ...l.quantity },
        unitRaw: l.unitRaw,
        unit: l.unit,
        removed: l.removed,
        amount: canAmount
          ? {
              visibility: 'visible',
              state: l.amount.state,
              value: l.amount.value,
              currency: r.currency,
            }
          : { visibility: 'restricted' },
        pricing: lineAllows('contract.terms')
          ? { visibility: 'visible', type: l.pricingType }
          : { visibility: 'restricted' },
        internal: internal
          ? {
              visibility: 'visible',
              includes: l.includes,
              excludes: l.excludes,
              derivation: l.derivation,
            }
          : { visibility: 'restricted' },
        allocation,
        sharedLineAmount: canAmount && active.length > 1,
        shares: shares
          .filter(
            (p) =>
              orgView ||
              (!p.retired &&
                allowsProject(g, 'contract.view', row.direction, p.projectId)),
          )
          .map((p) => shareProjection(p, internal, l)),
      };
    });
  return {
    n: s.n,
    name: r.name,
    originalNumber: r.originalNumber,
    counterpartyRaw: r.counterpartyRaw,
    selfPartyRaw: r.selfPartyRaw,
    informationOwnerPersonId: r.informationOwnerPersonId,
    registeredAt: s.registeredAt,
    signedOn: { ...r.signedOn },
    effectiveOn: { ...r.effectiveOn },
    registrationStatus: r.registrationStatus,
    lines,
    total: amount
      ? {
          visibility: 'visible',
          state: r.total.state,
          value: r.total.value,
          currency: r.currency,
        }
      : { visibility: 'restricted' },
    internal:
      amount && allowsHeader(g, 'contract.internal', row.direction)
        ? { visibility: 'visible', correctionReason: s.correctionReason }
        : { visibility: 'restricted' },
    evidence: allowsHeader(g, 'contract.original', row.direction)
      ? { visibility: 'visible', sources: r.sources.map((x) => ({ ...x })) }
      : { visibility: 'restricted' },
  };
}
function shareProjection(
  p: StoredShare,
  internal: boolean,
  line: StoredShare['pinnedLine'],
): ContractShareDto {
  return {
    scopeId: p.scopeId,
    projectId: p.projectId,
    version: p.expectedVersion,
    pinnedRevisionN: p.pinnedRevisionN,
    basis: p.basis,
    quantity: p.quantity,
    unitRaw: p.pinnedLine.unitRaw,
    unit: p.pinnedLine.unit,
    description: p.pinnedLine.description,
    retired: p.retired,
    needsReconciliation: !p.retired && executionChanged(p.pinnedLine, line),
    internal: internal
      ? { visibility: 'visible', area: p.area, note: p.note, reason: p.reason }
      : { visibility: 'restricted' },
  };
}
/** Every read, including editor recovery, rechecks current account/direction/scope grants. */
export class ContractRegisterReader {
  constructor(private readonly pool: Pool) {}
  private read<T>(
    identity: Identity,
    use: (c: PoolClient, a: Actor, g: ContractGrant[]) => Promise<T>,
  ): Promise<T> {
    return accountTransaction(
      this.pool,
      identity,
      {
        admit: (m) => m.length > 0,
        forbidden: () => new ContractRegisterError('FORBIDDEN'),
      },
      async (c, a) => use(c, a, await activeGrants(c, a)),
    );
  }
  private async visible(
    c: PoolClient,
    a: Actor,
    g: ContractGrant[],
    id: string,
  ): Promise<{ row: ContractIdentity; shares: StoredShare[] }> {
    await c.query(
      'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
      [`contract:${a.orgId}:${id}`],
    );
    const row = await identityRow(c, a.orgId, id);
    if (!row) throw new ContractRegisterError('NOT_FOUND');
    const shares = await currentShares(c, a.orgId, id);
    if (
      !allowsHeader(g, 'contract.view', row.direction) &&
      !shares.some(
        (s) =>
          !s.retired &&
          allowsProject(g, 'contract.view', row.direction, s.projectId),
      )
    )
      throw new ContractRegisterError('NOT_FOUND');
    return { row, shares };
  }
  private async attention(
    c: PoolClient,
    a: Actor,
    g: ContractGrant[],
    row: ContractIdentity,
  ): Promise<ContractRegisterItemDto['attention']> {
    if (!allowsHeader(g, 'contract.attention', row.direction))
      return { visibility: 'restricted' };
    const entries = (
      await c.query<{
        id: string;
        revisionN: number;
        kind: 'UNASSIGNED' | 'CORRECTION' | 'SHARE_MISASSIGNED';
        read: boolean;
        requiresAnotherPerson: boolean;
      }>(
        `SELECT e.id,e."revisionN",e.kind,
      EXISTS(SELECT 1 FROM "ContractAttentionRead" r WHERE r."orgId"=e."orgId" AND r."attentionId"=e.id AND NOT (r."byPersonId"=ANY(e."involvedPersonIds"))) AS read,
      ($3::uuid=ANY(e."involvedPersonIds")) AS "requiresAnotherPerson" FROM "ContractAttention" e WHERE e."orgId"=$1 AND e."contractId"=$2 ORDER BY e."createdAt",e.id`,
        [a.orgId, row.id, a.personId],
      )
    ).rows;
    return { visibility: 'visible', entries: entries.map((e) => ({ ...e })) };
  }
  lookups(identity: Identity): Promise<ContractEditorLookupsDto> {
    return this.read(identity, async (c, a, g) => {
      const directions = (['INCOME', 'EXPENDITURE'] as const).filter((d) =>
        maintainsOrganization(g, d),
      );
      const all = (
        await c.query<{ id: string; code: string; name: string }>(
          'SELECT id,code,name FROM "Project" WHERE "orgId"=$1 ORDER BY code,id',
          [a.orgId],
        )
      ).rows;
      const projects = all.filter((p) =>
        (['INCOME', 'EXPENDITURE'] as const).some((d) =>
          allowsProject(g, 'contract.view', d, p.id),
        ),
      );
      const maintainedProjects = (['INCOME', 'EXPENDITURE'] as const).map(
        (direction) => ({
          direction,
          projectIds: all
            .filter((p) => maintainsProjects(g, direction, [p.id]))
            .map((p) => p.id),
        }),
      );
      const people = directions.length
        ? (
            await c.query<{ id: string; displayName: string }>(
              'SELECT id,"displayName" FROM "Person" WHERE "orgId"=$1 ORDER BY "displayName",id',
              [a.orgId],
            )
          ).rows
        : [];
      const companies = directions.length
        ? (
            await c.query<{ id: string; name: string }>(
              'SELECT id,name FROM "Company" WHERE "orgId"=$1 ORDER BY name,id',
              [a.orgId],
            )
          ).rows
        : [];
      const sources = directions.length
        ? (
            await c.query<{ id: string; filename: string; sha256: string }>(
              'SELECT id,filename,sha256 FROM "SourceDocument" WHERE "orgId"=$1 ORDER BY filename,id',
              [a.orgId],
            )
          ).rows
        : [];
      return projected('contract-register.lookups', {
        accountId: a.accountId,
        directions,
        maintainedProjects,
        projects,
        people,
        companies,
        sources,
      });
    });
  }
  list(identity: Identity): Promise<ContractRegisterItemDto[]> {
    return this.read(identity, async (c, a, g) => {
      // SQL filters invisible records before ordering, with current active share scope.
      const dirs = (['INCOME', 'EXPENDITURE'] as const).filter((d) =>
        allowsHeader(g, 'contract.view', d),
      );
      const projects = g
        .filter(
          (x) => x.capability === 'contract.view' && x.scope === 'PROJECT',
        )
        .map((x) => ({ id: x.projectId, direction: x.direction }));
      const ids = (
        await c.query<{ id: string }>(
          `SELECT c.id FROM "Contract" c WHERE c."orgId"=$1 AND (c.direction=ANY($2::text[]) OR EXISTS (
      SELECT 1 FROM "ContractScope" s JOIN LATERAL (SELECT retired FROM "ContractScopeVersion" v WHERE v."orgId"=s."orgId" AND v."scopeId"=s.id ORDER BY v.n DESC LIMIT 1) v ON NOT v.retired
      JOIN jsonb_to_recordset($3::jsonb) AS grant_scope(id uuid,direction text) ON grant_scope.id=s."projectId" AND (grant_scope.direction='ALL' OR grant_scope.direction=c.direction)
      WHERE s."orgId"=c."orgId" AND s."contractId"=c.id)) ORDER BY c.code,c.id`,
          [a.orgId, dirs, JSON.stringify(projects)],
        )
      ).rows;
      const items: ContractRegisterItemDto[] = [];
      for (const { id } of ids) {
        let visible;
        try {
          visible = await this.visible(c, a, g, id);
        } catch (error) {
          if (
            error instanceof ContractRegisterError &&
            error.code === 'NOT_FOUND'
          )
            continue;
          throw error;
        }
        const { row, shares } = visible;
        const s = await snapshot(c, a.orgId, id);
        if (s)
          items.push({
            ...row,
            latest: revision(row, s, g, shares),
            attention: await this.attention(c, a, g, row),
          });
      }
      return projected('contract-register.list', items);
    });
  }
  detail(identity: Identity, id: string): Promise<ContractRegisterItemDto> {
    return this.read(identity, async (c, a, g) => {
      const { row, shares } = await this.visible(c, a, g, id);
      const s = await snapshot(c, a.orgId, id);
      if (!s) throw new ContractRegisterError('NOT_FOUND');
      return projected('contract-register.detail', {
        ...row,
        latest: revision(row, s, g, shares),
        attention: await this.attention(c, a, g, row),
      });
    });
  }
  history(identity: Identity, id: string): Promise<ContractHistoryDto> {
    return this.read(identity, async (c, a, g) => {
      const { row, shares } = await this.visible(c, a, g, id);
      const ns = (
        await c.query<{ n: number }>(
          'SELECT n FROM "ContractRevision" WHERE "orgId"=$1 AND "contractId"=$2 ORDER BY n DESC',
          [a.orgId, id],
        )
      ).rows;
      const revisions: ContractRevisionDto[] = [];
      for (const { n } of ns) {
        const s = await snapshot(c, a.orgId, id, n);
        if (s) revisions.push(revision(row, s, g, shares));
      }
      const orgView = allowsHeader(g, 'contract.view', row.direction);
      const visibleScopes = new Set(
        shares
          .filter(
            (p) =>
              !p.retired &&
              allowsProject(g, 'contract.view', row.direction, p.projectId),
          )
          .map((p) => p.scopeId),
      );
      const latest = await snapshot(c, a.orgId, id);
      const shareVersions = (
        await currentShares(c, a.orgId, id, undefined, true)
      )
        .filter((p) => orgView || visibleScopes.has(p.scopeId))
        .map((p) =>
          shareProjection(
            p,
            (allowsHeader(g, 'contract.amount', row.direction) ||
              allowsProject(
                g,
                'contract.amount',
                row.direction,
                p.projectId,
              )) &&
              (allowsHeader(g, 'contract.internal', row.direction) ||
                allowsProject(
                  g,
                  'contract.internal',
                  row.direction,
                  p.projectId,
                )),
            latest?.revision.lines.find((l) => l.id === p.pinnedLine.id) ??
              p.pinnedLine,
          ),
        );
      return projected('contract-register.history', {
        id,
        revisions,
        shareVersions,
      });
    });
  }
  editor(identity: Identity, id: string): Promise<ContractEditorDto> {
    return this.read(identity, async (c, a, g) => {
      const { row } = await this.visible(c, a, g, id);
      if (!maintainsOrganization(g, row.direction))
        throw new ContractRegisterError('FORBIDDEN');
      const s = await snapshot(c, a.orgId, id);
      if (!s) throw new ContractRegisterError('NOT_FOUND');
      return projected('contract-register.editor', {
        ...row,
        version: s.n,
        revision: s.revision,
      });
    });
  }
}
