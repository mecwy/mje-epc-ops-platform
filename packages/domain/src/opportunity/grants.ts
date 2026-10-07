import type { PoolClient } from 'pg';
import type { Actor } from '../store-kit.js';
import type { OpportunityGrant } from './rules.js';
export async function activeGrants(
  c: PoolClient,
  a: Actor,
): Promise<OpportunityGrant[]> {
  return (
    await c.query<OpportunityGrant>(
      `SELECT g.capability,g.source,g.scope,g."businessLine",g."opportunityId"
  FROM "OpportunityGrant" g JOIN "Membership" m ON m."orgId"=g."orgId" AND m.id=g."membershipId"
  WHERE g."orgId"=$1 AND g."accountId"=$2 AND g."personId"=$3 AND m."accountId"=$2 AND m."projectId" IS NULL
  AND m."activeFrom"<=$4::timestamptz AND (m."activeUntil" IS NULL OR m."activeUntil">$4::timestamptz)
  AND g."validFrom"<=$4::timestamptz AND g."validUntil">$4::timestamptz
  AND NOT EXISTS(SELECT 1 FROM "OpportunityGrantRevocation" r WHERE r."orgId"=g."orgId" AND r."grantId"=g.id)`,
      [a.orgId, a.accountId, a.personId, a.decidedAt],
    )
  ).rows;
}
/** Purpose-specific boolean exit: another Person's accounts stay hidden by RLS. */
export async function representedCanDecide(
  c: PoolClient,
  a: Actor,
  personId: string,
  opportunityId: string,
): Promise<boolean> {
  return (
    (
      await c.query<{ allowed: boolean }>(
        'SELECT opportunity_represented_decides($1,$2,$3) AS allowed',
        [a.orgId, personId, opportunityId],
      )
    ).rows[0]?.allowed === true
  );
}
