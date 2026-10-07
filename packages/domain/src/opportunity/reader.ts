import type { Pool, PoolClient } from 'pg';
import type {
  OpportunityLookupsDto,
  OpportunityWorklistsDto,
  OpportunityItemDto,
} from '@mje/contracts';
import type { Identity } from '../alpha-store.js';
import { accountTransaction, type Actor } from '../store-kit.js';
import { activeGrants } from './grants.js';
import { canCreate, OpportunityError, type OpportunityGrant } from './rules.js';
import { stored, eligibleOpportunitySource } from './data.js';
import { projection } from './projection.js';
export const OPPORTUNITY_PROJECTORS = [
  'opportunity.list',
  'opportunity.detail',
  'opportunity.history',
  'opportunity.lookups',
  'opportunity.worklists',
] as const;
let observer: ((name: (typeof OPPORTUNITY_PROJECTORS)[number]) => void) | null =
  null;
export function observeOpportunityProjections(next: typeof observer) {
  if (next && process.env['NODE_ENV'] !== 'test')
    throw new Error('test-only observer');
  observer = next;
}
function projected<T>(
  name: (typeof OPPORTUNITY_PROJECTORS)[number],
  value: T,
): T {
  try {
    observer?.(name);
  } catch {
    /* observation adds no access */
  }
  return value;
}
export class OpportunityReader {
  constructor(private readonly pool: Pool) {}
  private tx<T>(
    identity: Identity,
    work: (c: PoolClient, a: Actor, g: OpportunityGrant[]) => Promise<T>,
  ) {
    return accountTransaction(
      this.pool,
      identity,
      {
        admit: (m) => m.length > 0,
        forbidden: () => new OpportunityError('FORBIDDEN'),
      },
      async (c, a) => work(c, a, await activeGrants(c, a)),
    );
  }
  private async all(
    c: PoolClient,
    a: Actor,
    g: OpportunityGrant[],
  ): Promise<OpportunityItemDto[]> {
    const ids = (
      await c.query<{ id: string }>(
        'SELECT DISTINCT "opportunityId" AS id FROM "OpportunityRecord" WHERE "orgId"=$1',
        [a.orgId],
      )
    ).rows;
    const items: OpportunityItemDto[] = [];
    for (const { id } of ids) {
      const row = await stored(c, a.orgId, id);
      const p = row ? projection(row, g) : null;
      if (p) items.push(p.item);
    }
    return items.sort((a, b) => a.code.localeCompare(b.code));
  }
  list(identity: Identity) {
    return this.tx(identity, async (c, a, g) =>
      projected('opportunity.list', { items: await this.all(c, a, g) }),
    );
  }
  detail(identity: Identity, id: string) {
    return this.tx(identity, async (c, a, g) => {
      const row = await stored(c, a.orgId, id),
        p = row ? projection(row, g) : null;
      if (!p) throw new OpportunityError('NOT_FOUND');
      return projected('opportunity.detail', p.item);
    });
  }
  history(identity: Identity, id: string) {
    return this.tx(identity, async (c, a, g) => {
      const row = await stored(c, a.orgId, id),
        p = row ? projection(row, g) : null;
      if (!p) throw new OpportunityError('NOT_FOUND');
      return projected('opportunity.history', p.history);
    });
  }
  lookups(identity: Identity): Promise<OpportunityLookupsDto> {
    return this.tx(identity, async (c, a, g) => {
      // Lookups are reference-only and do not confer master-data writes or original file access.
      const permitted =
        canCreate(g) ||
        g.some(
          (x) =>
            x.capability === 'opportunity.maintain' ||
            x.capability === 'opportunity.decide',
        );
      const text =
        g.some(
          (x) => x.scope === 'ORG' && x.capability === 'opportunity.amount',
        ) &&
        g.some(
          (x) => x.scope === 'ORG' && x.capability === 'opportunity.internal',
        );
      const people = permitted
        ? (
            await c.query<{ id: string; displayName: string }>(
              'SELECT id,"displayName" FROM "Person" WHERE "orgId"=$1 ORDER BY id',
              [a.orgId],
            )
          ).rows
        : [];
      const companies = permitted
        ? (
            await c.query<{ id: string; name: string }>(
              'SELECT id,name FROM "Company" WHERE "orgId"=$1 ORDER BY id',
              [a.orgId],
            )
          ).rows
        : [];
      const sources =
        permitted && text
          ? (
              await c.query<{ id: string; filename: string; sha256: string }>(
                `SELECT id,filename,sha256 FROM "SourceDocument" WHERE "orgId"=$1 AND ${eligibleOpportunitySource('$1', 'id')} ORDER BY id`,
                [a.orgId],
              )
            ).rows
          : [];
      return projected('opportunity.lookups', {
        accountId: a.accountId,
        personId: a.personId,
        canCreateLead: canCreate(g),
        people,
        companies,
        sources,
      });
    });
  }
  worklists(identity: Identity): Promise<OpportunityWorklistsDto> {
    return this.tx(identity, async (c, a, g) => {
      const items = await this.all(c, a, g),
        date = new Date(a.decidedAt),
        start = new Date(date);
      start.setUTCHours(0, 0, 0, 0);
      start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 7);
      const weekChanges: OpportunityWorklistsDto['weekChanges'] = [];
      for (const item of items) {
        const row = await stored(c, a.orgId, item.id),
          p = row ? projection(row, g) : null;
        if (p)
          for (const update of p.history.updates)
            if (
              !update.noMaterialChange &&
              update.recordedAt >= start.toISOString() &&
              update.recordedAt < end.toISOString()
            )
              weekChanges.push({ opportunityId: item.id, update });
      }
      return projected('opportunity.worklists', {
        accountId: a.accountId,
        items,
        myNextSteps: items.flatMap((x) =>
          x.nextStep?.ownerPersonId === a.personId
            ? [{ opportunityId: x.id, step: x.nextStep }]
            : [],
        ),
        pendingDecisions: items.flatMap((x) =>
          x.pendingRequest
            ? [{ opportunityId: x.id, request: x.pendingRequest }]
            : [],
        ),
        weekChanges,
        recordedWeek: { start: start.toISOString(), end: end.toISOString() },
      });
    });
  }
}
