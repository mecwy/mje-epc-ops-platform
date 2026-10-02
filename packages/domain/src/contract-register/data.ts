/** Private persistence representation. Only Reader/Commands leave this module. */
import type { PoolClient } from 'pg';
import type {
  ContractDirection,
  ContractLineInput,
  ContractRevisionInput,
  ContractLocation,
} from '@mje/contracts';
import type { StoredShare } from './validation.js';
export interface ContractIdentity {
  id: string;
  code: string;
  direction: ContractDirection;
  expenditureSubtype: 'SUBCONTRACT' | 'PURCHASE' | null;
}
export async function identityRow(
  c: PoolClient,
  orgId: string,
  id: string,
): Promise<ContractIdentity | null> {
  return (
    (
      await c.query<ContractIdentity>(
        'SELECT id,code,direction,"expenditureSubtype" FROM "Contract" WHERE "orgId"=$1 AND id=$2',
        [orgId, id],
      )
    ).rows[0] ?? null
  );
}
export interface Snapshot {
  n: number;
  registeredByPersonId: string;
  registeredAt: string;
  correctionReason: string | null;
  revision: ContractRevisionInput;
}
interface HeaderRow extends Omit<
  ContractRevisionInput,
  'signedOn' | 'effectiveOn' | 'total' | 'headLocs' | 'lines' | 'sources'
> {
  n: number;
  registeredByPersonId: string;
  registeredAt: Date;
  correctionReason: string | null;
  signedOnState: ContractRevisionInput['signedOn']['state'];
  signedOn: string | null;
  effectiveOnState: ContractRevisionInput['effectiveOn']['state'];
  effectiveOn: string | null;
  totalState: ContractRevisionInput['total']['state'];
  totalAmount: string | null;
  partiesSourceId: string | null;
  partiesLocation: string | null;
  datesSourceId: string | null;
  datesLocation: string | null;
  totalSourceId: string | null;
  totalLocation: string | null;
}
const location = (
  id: string | null,
  text: string | null,
): ContractLocation | null =>
  id && text ? { sourceDocumentId: id, location: text } : null;
export async function lineRows(
  c: PoolClient,
  orgId: string,
  id: string,
  n: number,
): Promise<ContractLineInput[]> {
  return (
    await c.query<ContractLineInput>(
      `SELECT "lineId" AS id,"lineNo",description,
    jsonb_build_object('state',"quantityState",'value',quantity::text) AS quantity,"unitRaw",unit,"pricingType",
    jsonb_build_object('state',"amountState",'value',amount::text) AS amount,includes,excludes,derivation,
    CASE WHEN "sourceDocumentId" IS NULL THEN NULL ELSE jsonb_build_object('sourceDocumentId',"sourceDocumentId",'location',location) END AS source,removed,
    CASE WHEN "removalSourceDocumentId" IS NULL THEN NULL ELSE jsonb_build_object('sourceDocumentId',"removalSourceDocumentId",'location',"removalLocation") END AS "removalSource"
    FROM "ContractLineRevision" WHERE "orgId"=$1 AND "contractId"=$2 AND n=$3 ORDER BY "lineNo","lineId"`,
      [orgId, id, n],
    )
  ).rows;
}
export async function snapshot(
  c: PoolClient,
  orgId: string,
  id: string,
  n?: number,
): Promise<Snapshot | null> {
  const r = (
    await c.query<HeaderRow>(
      `SELECT *,"totalAmount"::text,"signedOn"::text,"effectiveOn"::text FROM "ContractRevision" WHERE "orgId"=$1 AND "contractId"=$2 AND ($3::int IS NULL OR n=$3) ORDER BY n DESC LIMIT 1`,
      [orgId, id, n ?? null],
    )
  ).rows[0];
  if (!r) return null;
  const sources = (
    await c.query<ContractLocation>(
      'SELECT "sourceDocumentId",location FROM "ContractRevisionSource" WHERE "orgId"=$1 AND "contractId"=$2 AND n=$3 ORDER BY "sourceDocumentId",location',
      [orgId, id, r.n],
    )
  ).rows;
  return {
    n: r.n,
    registeredByPersonId: r.registeredByPersonId,
    registeredAt: r.registeredAt.toISOString(),
    correctionReason: r.correctionReason,
    revision: {
      name: r.name,
      originalNumber: r.originalNumber,
      counterpartyRaw: r.counterpartyRaw,
      selfPartyRaw: r.selfPartyRaw,
      counterpartyCompanyId: r.counterpartyCompanyId,
      selfCompanyId: r.selfCompanyId,
      informationOwnerPersonId: r.informationOwnerPersonId,
      signedOn: { state: r.signedOnState, value: r.signedOn },
      effectiveOn: { state: r.effectiveOnState, value: r.effectiveOn },
      registrationStatus: r.registrationStatus,
      total: { state: r.totalState, value: r.totalAmount },
      currency: r.currency,
      taxBasis: r.taxBasis,
      sources,
      headLocs: {
        parties: location(r.partiesSourceId, r.partiesLocation),
        dates: location(r.datesSourceId, r.datesLocation),
        total: location(r.totalSourceId, r.totalLocation),
      },
      lines: await lineRows(c, orgId, id, r.n),
    },
  };
}
export async function currentShares(
  c: PoolClient,
  orgId: string,
  id: string,
  lineId?: string,
  history = false,
): Promise<StoredShare[]> {
  const rows = (
    await c.query<Omit<StoredShare, 'pinnedLine'> & { lineId: string }>(
      `SELECT s.id AS "scopeId",s."projectId",s."contractLineId" AS "lineId",v.n AS "expectedVersion",v.basis,v.quantity::text,v.area,v.note,v.retired,v.reason,v."contractRevisionN" AS "pinnedRevisionN"
    FROM "ContractScope" s JOIN LATERAL (SELECT * FROM "ContractScopeVersion" x WHERE x."orgId"=s."orgId" AND x."scopeId"=s.id ORDER BY x.n DESC ${history ? '' : 'LIMIT 1'}) v ON true
    WHERE s."orgId"=$1 AND s."contractId"=$2 AND ($3::uuid IS NULL OR s."contractLineId"=$3) ORDER BY s.id,v.n DESC`,
      [orgId, id, lineId ?? null],
    )
  ).rows;
  const cache = new Map<number, ContractLineInput[]>();
  const result: StoredShare[] = [];
  for (const r of rows) {
    if (!cache.has(r.pinnedRevisionN))
      cache.set(
        r.pinnedRevisionN,
        await lineRows(c, orgId, id, r.pinnedRevisionN),
      );
    const pinnedLine = cache
      .get(r.pinnedRevisionN)!
      .find((l) => l.id === r.lineId);
    if (!pinnedLine) throw new Error('contract share provenance missing');
    result.push({ ...r, pinnedLine });
  }
  return result;
}
