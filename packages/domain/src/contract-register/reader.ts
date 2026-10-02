import type { Pool, PoolClient } from 'pg';
import type {
  ContractDirection,
  ContractHistoryDto,
  ContractRegisterItemDto,
  ContractRevisionDto,
  ContractValueState,
} from '@mje/contracts';
import type { Identity } from '../alpha-store.js';
import { accountTransaction, type Actor } from '../store-kit.js';
import { activeGrants } from './grants.js';
import {
  allowsHeader,
  ContractRegisterError,
  type ContractGrant,
} from './rules.js';
interface Row {
  id: string;
  code: string;
  direction: ContractDirection;
  expenditureSubtype: 'SUBCONTRACT' | 'PURCHASE' | null;
  n: number;
  name: string;
  originalNumber: string | null;
  counterpartyRaw: string | null;
  selfPartyRaw: string | null;
  informationOwnerPersonId: string | null;
  registeredAt: Date;
  totalState: ContractValueState;
  totalAmount: string | null;
  currency: string | null;
  correctionReason: string | null;
  sources: { sourceDocumentId: string; location: string }[];
}
export const CONTRACT_PROJECTORS = [
  'contract-register.list',
  'contract-register.detail',
  'contract-register.history',
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
    /* Observation cannot change authorization. */
  }
  return value;
}
function revision(r: Row, grants: ContractGrant[]): ContractRevisionDto {
  const amount = allowsHeader(grants, 'contract.amount', r.direction);
  return {
    n: r.n,
    name: r.name,
    originalNumber: r.originalNumber,
    counterpartyRaw: r.counterpartyRaw,
    selfPartyRaw: r.selfPartyRaw,
    informationOwnerPersonId: r.informationOwnerPersonId,
    registeredAt: r.registeredAt.toISOString(),
    total: amount
      ? {
          visibility: 'visible',
          state: r.totalState,
          value: r.totalAmount,
          currency: r.currency,
        }
      : { visibility: 'restricted' },
    internal:
      amount && allowsHeader(grants, 'contract.internal', r.direction)
        ? { visibility: 'visible', correctionReason: r.correctionReason }
        : { visibility: 'restricted' },
    evidence: allowsHeader(grants, 'contract.original', r.direction)
      ? {
          visibility: 'visible',
          sources: r.sources.map((s) => ({
            sourceDocumentId: s.sourceDocumentId,
            location: s.location,
          })),
        }
      : { visibility: 'restricted' },
  };
}
function item(r: Row, grants: ContractGrant[]): ContractRegisterItemDto {
  return {
    id: r.id,
    code: r.code,
    direction: r.direction,
    expenditureSubtype: r.expenditureSubtype,
    latest: revision(r, grants),
  };
}
/** Raw rows stay private to this module; every controller path uses the same projection. */
export class ContractRegisterReader {
  constructor(private readonly pool: Pool) {}
  private async read<T>(
    identity: Identity,
    use: (
      client: PoolClient,
      actor: Actor,
      grants: ContractGrant[],
    ) => Promise<T>,
  ): Promise<T> {
    return accountTransaction(
      this.pool,
      identity,
      {
        admit: (m) => m.length > 0,
        forbidden: () => new ContractRegisterError('FORBIDDEN'),
      },
      async (client, actor) =>
        use(client, actor, await activeGrants(client, actor)),
    );
  }
  private async rows(
    client: PoolClient,
    actor: Actor,
    grants: ContractGrant[],
    id: string | null,
    history: boolean,
  ): Promise<Row[]> {
    const directions = (['INCOME', 'EXPENDITURE'] as const).filter((d) =>
      allowsHeader(grants, 'contract.view', d),
    );
    // Restrict before ordering/limiting: hidden records cannot affect visible page contents.
    return (
      await client.query<Row>(
        `
      SELECT c.id,c.code,c.direction,c."expenditureSubtype",r.n,r.name,r."originalNumber",r."counterpartyRaw",r."selfPartyRaw",r."informationOwnerPersonId",r."registeredAt",r."totalState",r."totalAmount"::text,r.currency,r."correctionReason",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('sourceDocumentId',s."sourceDocumentId",'location',s.location) ORDER BY s."sourceDocumentId",s.location)
          FROM "ContractRevisionSource" s WHERE s."orgId"=r."orgId" AND s."contractId"=r."contractId" AND s.n=r.n),'[]'::jsonb) AS sources
      FROM "Contract" c JOIN "ContractRevision" r ON r."orgId"=c."orgId" AND r."contractId"=c.id
      WHERE c."orgId"=$1 AND c.direction=ANY($2::text[]) AND ($3::uuid IS NULL OR c.id=$3)
        AND ($4 OR r.n=(SELECT max(v.n) FROM "ContractRevision" v WHERE v."orgId"=c."orgId" AND v."contractId"=c.id))
      ORDER BY c.code,c.id,r.n DESC
    `,
        [actor.orgId, directions, id, history],
      )
    ).rows;
  }
  list(identity: Identity): Promise<ContractRegisterItemDto[]> {
    return this.read(identity, async (c, a, g) =>
      projected(
        'contract-register.list',
        (await this.rows(c, a, g, null, false)).map((r) => item(r, g)),
      ),
    );
  }
  detail(identity: Identity, id: string): Promise<ContractRegisterItemDto> {
    return this.read(identity, async (c, a, g) => {
      const r = (await this.rows(c, a, g, id, false))[0];
      if (!r) throw new ContractRegisterError('NOT_FOUND');
      return projected('contract-register.detail', item(r, g));
    });
  }
  history(identity: Identity, id: string): Promise<ContractHistoryDto> {
    return this.read(identity, async (c, a, g) => {
      const rows = await this.rows(c, a, g, id, true);
      if (!rows.length) throw new ContractRegisterError('NOT_FOUND');
      return projected('contract-register.history', {
        id,
        revisions: rows.map((r) => revision(r, g)),
      });
    });
  }
}
