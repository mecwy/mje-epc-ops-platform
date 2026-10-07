-- Forward-only repair: creation authority cannot self-perpetuate through Q6 grants.
CREATE OR REPLACE FUNCTION opportunity_create_grants() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 DECLARE mid UUID; until_time TIMESTAMPTZ; actor UUID; BEGIN
 IF NEW.kind<>'CREATE' THEN RETURN NULL; END IF;
 SELECT a.id INTO actor FROM public."LoginAccount" a WHERE a."orgId"=NEW."orgId" AND a.id=NEW."recordedByAccountId"
 AND a."personId"=NEW."recordedByPersonId" AND a.active AND a."entraTenantId"=current_setting('app.tenant_id',true)
 AND a."entraObjectId"=current_setting('app.object_id',true);
 IF actor IS NULL THEN RAISE EXCEPTION 'opportunity creation account is not admitted'; END IF;
 SELECT m.id,least(g."validUntil",coalesce(m."activeUntil",g."validUntil")) INTO mid,until_time
 FROM public."OpportunityGrant" g JOIN public."Membership" m ON m."orgId"=g."orgId" AND m.id=g."membershipId" AND m."accountId"=g."accountId"
 WHERE g."orgId"=NEW."orgId" AND g."accountId"=actor AND g."personId"=NEW."recordedByPersonId" AND g.capability='opportunity.maintain' AND g.scope='ORG' AND g.source<>'system:opportunity.create'
 AND m."projectId" IS NULL AND m."activeFrom"<=NEW."recordedAt" AND (m."activeUntil" IS NULL OR m."activeUntil">NEW."recordedAt")
 AND g."validFrom"<=NEW."recordedAt" AND g."validUntil">NEW."recordedAt"
 AND NOT EXISTS(SELECT 1 FROM public."OpportunityGrantRevocation" r WHERE r."orgId"=g."orgId" AND r."grantId"=g.id)
 ORDER BY least(g."validUntil",coalesce(m."activeUntil",g."validUntil")) DESC,g.id LIMIT 1;
 IF mid IS NULL THEN RAISE EXCEPTION 'opportunity creation grant is not admitted'; END IF;
 INSERT INTO public."OpportunityGrant"(id,"orgId","membershipId","accountId","personId",capability,scope,"opportunityId","validFrom","validUntil",basis,source,"grantedBy")
 SELECT gen_random_uuid(),NEW."orgId",mid,actor,NEW."recordedByPersonId",cap,'OPPORTUNITY',NEW."opportunityId",NEW."recordedAt",until_time,'Q6: explicit revocable creation grant','system:opportunity.create',actor
 FROM unnest(ARRAY['opportunity.maintain','opportunity.internal']) cap;
 RETURN NULL; END $$;

-- Explicit controlled classification; no app intake/upload/administration entry.
CREATE TABLE "OpportunitySourceIntake" (
 id UUID PRIMARY KEY, "orgId" UUID NOT NULL, "sourceDocumentId" UUID NOT NULL,
 basis TEXT NOT NULL CHECK(btrim(basis)<>''), "registeredBy" UUID NOT NULL,
 "registeredAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE("orgId",id), UNIQUE("orgId","sourceDocumentId"),
 FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","sourceDocumentId") REFERENCES "SourceDocument"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","registeredBy") REFERENCES "LoginAccount"("orgId",id) ON DELETE RESTRICT
);
CREATE TRIGGER "OpportunitySourceIntake_append_only" BEFORE UPDATE OR DELETE ON "OpportunitySourceIntake"
 FOR EACH ROW EXECUTE FUNCTION contract_register_append_only();
ALTER TABLE "OpportunitySourceIntake" ENABLE ROW LEVEL SECURITY;
CREATE POLICY alpha_org ON "OpportunitySourceIntake" TO mje_alpha_app USING("orgId"::text=current_setting('app.org_id',true));
GRANT SELECT ON "OpportunitySourceIntake" TO mje_alpha_app;

-- Contract-owned classification exit, callable only by the enclosing owner-owned exit.
CREATE FUNCTION contract_source_is_classified(org UUID,document UUID) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public."ContractSourceIntake" s WHERE s."orgId"=org AND s."sourceDocumentId"=document)
 OR EXISTS(SELECT 1 FROM public."ContractRevisionSource" s WHERE s."orgId"=org AND s."sourceDocumentId"=document)
$$;
REVOKE ALL ON FUNCTION contract_source_is_classified(UUID,UUID) FROM PUBLIC;

-- Source ownership exit: an opaque eligible/not-eligible boolean, never contract metadata.
CREATE FUNCTION opportunity_source_is_eligible(org UUID,document UUID) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(org::text=current_setting('app.org_id',true),false)
 AND EXISTS(SELECT 1 FROM public."OpportunitySourceIntake" s WHERE s."orgId"=org AND s."sourceDocumentId"=document)
 AND NOT public.contract_source_is_classified(org,document)
$$;
REVOKE ALL ON FUNCTION opportunity_source_is_eligible(UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION opportunity_source_is_eligible(UUID,UUID) TO mje_alpha_app;

CREATE FUNCTION opportunity_guard_source() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF NEW."sourceDocumentId" IS NOT NULL AND NOT public.opportunity_source_is_eligible(NEW."orgId",NEW."sourceDocumentId")
 THEN RAISE EXCEPTION 'opportunity source is not eligible' USING ERRCODE='42501'; END IF;
 RETURN NEW; END $$;
REVOKE ALL ON FUNCTION opportunity_guard_source() FROM PUBLIC;
CREATE TRIGGER opportunity_guard_source BEFORE INSERT ON "OpportunityRecordSource"
 FOR EACH ROW EXECUTE FUNCTION opportunity_guard_source();
