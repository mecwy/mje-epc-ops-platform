-- A represented Person's other accounts remain invisible through LoginAccount RLS.
-- This purpose-specific exit returns one boolean, never account IDs, grant rows or private text.
CREATE FUNCTION opportunity_represented_decides(org UUID, represented UUID, opportunity UUID)
RETURNS BOOLEAN LANGUAGE sql STRICT SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH latest AS (
  SELECT r.facts FROM public."OpportunityRecord" r WHERE r."orgId"=$1 AND r."opportunityId"=$3 ORDER BY n DESC LIMIT 1
 ), valid AS (
  SELECT g.*,a."entraTenantId",a."entraObjectId" FROM public."OpportunityGrant" g
  JOIN public."Membership" m ON m."orgId"=g."orgId" AND m.id=g."membershipId" AND m."accountId"=g."accountId"
  JOIN public."LoginAccount" a ON a."orgId"=g."orgId" AND a.id=g."accountId" AND a."personId"=g."personId"
  CROSS JOIN latest l
  WHERE g."orgId"=$1 AND $1::text=current_setting('app.org_id',true) AND a.active AND m."projectId" IS NULL
  AND m."activeFrom"<=current_setting('app.decided_at',true)::timestamptz AND (m."activeUntil" IS NULL OR m."activeUntil">current_setting('app.decided_at',true)::timestamptz)
  AND g."validFrom"<=current_setting('app.decided_at',true)::timestamptz AND g."validUntil">current_setting('app.decided_at',true)::timestamptz
  AND NOT EXISTS(SELECT 1 FROM public."OpportunityGrantRevocation" r WHERE r."orgId"=g."orgId" AND r."grantId"=g.id)
  AND (g.scope='ORG' OR (g.scope='OPPORTUNITY' AND g."opportunityId"=$3) OR
   (g.scope='BUSINESS_LINE' AND l.facts->'businessLine'->>'state'='VALUE' AND g."businessLine"=l.facts->'businessLine'->>'value'))
 )
 SELECT EXISTS(SELECT 1 FROM valid WHERE "personId"=$2 AND capability='opportunity.decide')
 AND EXISTS(SELECT 1 FROM valid WHERE capability='opportunity.decide' AND "entraTenantId"=current_setting('app.tenant_id',true) AND "entraObjectId"=current_setting('app.object_id',true))
 AND EXISTS(SELECT 1 FROM valid WHERE capability='opportunity.view' AND "entraTenantId"=current_setting('app.tenant_id',true) AND "entraObjectId"=current_setting('app.object_id',true))
$$;
REVOKE ALL ON FUNCTION opportunity_represented_decides(UUID,UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION opportunity_represented_decides(UUID,UUID,UUID) TO mje_alpha_app;
