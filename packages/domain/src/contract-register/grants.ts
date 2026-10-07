import type { PoolClient } from 'pg';
import type { Actor } from '../store-kit.js';
import type { ContractGrant } from './rules.js';
/** Called only inside accountTransaction, after its account share lock and DB decision time. */
export async function activeGrants(
  client: PoolClient,
  actor: Actor,
): Promise<ContractGrant[]> {
  return (
    await client.query<ContractGrant>(
      `
    SELECT g.capability,g.direction,g.scope,g."projectId"
    FROM "ContractGrant" g JOIN "Membership" m ON m."orgId"=g."orgId" AND m.id=g."membershipId"
    WHERE g."orgId"=$1 AND m."accountId"=$2 AND g."accountId"=$2 AND g."personId"=$3
      AND m."activeFrom"<=$4::timestamptz AND (m."activeUntil" IS NULL OR m."activeUntil">$4::timestamptz)
      AND g."validFrom"<=$4::timestamptz AND g."validUntil">$4::timestamptz
      AND (m."projectId" IS NULL OR (g.scope='PROJECT' AND m."projectId"=g."projectId"))
      AND NOT EXISTS (SELECT 1 FROM "ContractGrantRevocation" r WHERE r."orgId"=g."orgId" AND r."grantId"=g.id)
  `,
      [actor.orgId, actor.accountId, actor.personId, actor.decidedAt],
    )
  ).rows;
}
