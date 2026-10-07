-- DG06 core. Immutable, validated snapshots; no quotation/award/contract linkage or financial aggregate.
CREATE FUNCTION app_account_for_identity_write(tenant TEXT, oid TEXT)
RETURNS TABLE ("orgId" UUID, id UUID, "personId" UUID, "authzVersion" INTEGER)
LANGUAGE sql STRICT SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT a."orgId",a.id,a."personId",a."authzVersion" FROM public."LoginAccount" a
 WHERE a.active AND a."personId" IS NOT NULL AND a."entraTenantId"=$1 AND a."entraObjectId"=$2
 AND $1=current_setting('app.tenant_id',true) AND $2=current_setting('app.object_id',true) FOR UPDATE OF a
$$;
REVOKE ALL ON FUNCTION app_account_for_identity_write(TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_account_for_identity_write(TEXT,TEXT) TO mje_alpha_app;

CREATE TABLE "OpportunityRecord" (
 id UUID PRIMARY KEY,"orgId" UUID NOT NULL,"opportunityId" UUID NOT NULL,n INTEGER NOT NULL CHECK(n>0),
 kind TEXT NOT NULL CHECK(kind IN ('CREATE','UPDATE','REQUEST','DECISION')),facts JSONB NOT NULL CHECK(jsonb_typeof(facts)='object'),
 payload JSONB NOT NULL CHECK(jsonb_typeof(payload)='object'),"recordedByAccountId" UUID NOT NULL,"recordedByPersonId" UUID NOT NULL,
 "recordedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE("orgId",id),UNIQUE("orgId","opportunityId",n),
 CHECK((kind='CREATE')=(n=1)),
 FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","opportunityId") REFERENCES "Opportunity"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","recordedByAccountId") REFERENCES "LoginAccount"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","recordedByPersonId") REFERENCES "Person"("orgId",id) ON DELETE RESTRICT
);
CREATE TABLE "OpportunityRecordPerson" (
 id UUID PRIMARY KEY,"orgId" UUID NOT NULL,"recordId" UUID NOT NULL,"personId" UUID NOT NULL,
 UNIQUE("orgId",id),UNIQUE("orgId","recordId","personId"),
 FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","recordId") REFERENCES "OpportunityRecord"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","personId") REFERENCES "Person"("orgId",id) ON DELETE RESTRICT
);
CREATE TABLE "OpportunityRecordCompany" (
 id UUID PRIMARY KEY,"orgId" UUID NOT NULL,"recordId" UUID NOT NULL,"companyId" UUID NOT NULL,
 UNIQUE("orgId",id),UNIQUE("orgId","recordId","companyId"),
 FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","recordId") REFERENCES "OpportunityRecord"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","companyId") REFERENCES "Company"("orgId",id) ON DELETE RESTRICT
);
CREATE TABLE "OpportunityRecordSource" (
 id UUID PRIMARY KEY,"orgId" UUID NOT NULL,"recordId" UUID NOT NULL,"sourceDocumentId" UUID,
 reference TEXT NOT NULL CHECK(btrim(reference)<>''),location TEXT NOT NULL CHECK(btrim(location)<>''),
 UNIQUE("orgId",id),
 FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","recordId") REFERENCES "OpportunityRecord"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","sourceDocumentId") REFERENCES "SourceDocument"("orgId",id) ON DELETE RESTRICT
);
CREATE TABLE "OpportunityGrant" (
 id UUID PRIMARY KEY,"orgId" UUID NOT NULL,"membershipId" UUID NOT NULL,"accountId" UUID NOT NULL,"personId" UUID NOT NULL,
 capability TEXT NOT NULL CHECK(capability IN ('opportunity.view','opportunity.maintain','opportunity.amount','opportunity.internal','opportunity.decide')),
 scope TEXT NOT NULL CHECK(scope IN ('ORG','BUSINESS_LINE','OPPORTUNITY')),"businessLine" TEXT,"opportunityId" UUID,
 "validFrom" TIMESTAMPTZ NOT NULL,"validUntil" TIMESTAMPTZ NOT NULL CHECK("validUntil">"validFrom"),
 basis TEXT NOT NULL CHECK(btrim(basis)<>''),source TEXT NOT NULL CHECK(btrim(source)<>''),"templateVersion" TEXT,
 "grantedBy" UUID NOT NULL,"grantedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),"representedPersonId" UUID,"delegationBasis" TEXT,
 "delegationFrom" TIMESTAMPTZ,"delegationUntil" TIMESTAMPTZ,
 UNIQUE("orgId",id),
 CHECK((scope='ORG' AND "businessLine" IS NULL AND "opportunityId" IS NULL) OR
 (scope='BUSINESS_LINE' AND "businessLine" IS NOT NULL AND btrim("businessLine")<>'' AND "opportunityId" IS NULL) OR
 (scope='OPPORTUNITY' AND "businessLine" IS NULL AND "opportunityId" IS NOT NULL)),
 CHECK(("representedPersonId" IS NULL AND "delegationBasis" IS NULL AND "delegationFrom" IS NULL AND "delegationUntil" IS NULL) OR
 ("representedPersonId" IS NOT NULL AND "delegationBasis" IS NOT NULL AND btrim("delegationBasis")<>'' AND "delegationFrom" IS NOT NULL AND "delegationUntil" IS NOT NULL AND "delegationUntil">"delegationFrom")),
 FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","membershipId") REFERENCES "Membership"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","accountId") REFERENCES "LoginAccount"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","personId") REFERENCES "Person"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","opportunityId") REFERENCES "Opportunity"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","grantedBy") REFERENCES "LoginAccount"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","representedPersonId") REFERENCES "Person"("orgId",id) ON DELETE RESTRICT
);
CREATE TABLE "OpportunityGrantRevocation" (
 id UUID PRIMARY KEY,"orgId" UUID NOT NULL,"grantId" UUID NOT NULL,"revokedBy" UUID NOT NULL,reason TEXT NOT NULL CHECK(btrim(reason)<>''),at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE("orgId",id),UNIQUE("orgId","grantId"),
 FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","grantId") REFERENCES "OpportunityGrant"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","revokedBy") REFERENCES "LoginAccount"("orgId",id) ON DELETE RESTRICT
);
CREATE FUNCTION opportunity_grant_version() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$ DECLARE target UUID; BEGIN
 IF TG_TABLE_NAME='OpportunityGrant' THEN target:=NEW."accountId";
 ELSE SELECT g."accountId" INTO target FROM public."OpportunityGrant" g WHERE g."orgId"=NEW."orgId" AND g.id=NEW."grantId"; END IF;
 UPDATE public."LoginAccount" SET "authzVersion"="authzVersion"+1 WHERE "orgId"=NEW."orgId" AND id=target; RETURN NULL; END $$;
CREATE TRIGGER opportunity_grant_version AFTER INSERT ON "OpportunityGrant" FOR EACH ROW EXECUTE FUNCTION opportunity_grant_version();
CREATE TRIGGER opportunity_revoke_version AFTER INSERT ON "OpportunityGrantRevocation" FOR EACH ROW EXECUTE FUNCTION opportunity_grant_version();
REVOKE ALL ON FUNCTION opportunity_grant_version() FROM PUBLIC;

-- The app cannot arbitrarily insert grants. Q6 is a narrow CREATE trigger, bounded by the
-- actor's current non-project membership and the authorizing maintenance grant validity.
CREATE FUNCTION opportunity_create_grants() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 DECLARE mid UUID; until_time TIMESTAMPTZ; actor UUID; BEGIN
 IF NEW.kind<>'CREATE' THEN RETURN NULL; END IF;
 SELECT a.id INTO actor FROM public."LoginAccount" a WHERE a."orgId"=NEW."orgId" AND a.id=NEW."recordedByAccountId"
 AND a."personId"=NEW."recordedByPersonId" AND a.active AND a."entraTenantId"=current_setting('app.tenant_id',true)
 AND a."entraObjectId"=current_setting('app.object_id',true);
 IF actor IS NULL THEN RAISE EXCEPTION 'opportunity creation account is not admitted'; END IF;
 SELECT m.id,least(g."validUntil",coalesce(m."activeUntil",g."validUntil")) INTO mid,until_time
 FROM public."OpportunityGrant" g JOIN public."Membership" m ON m."orgId"=g."orgId" AND m.id=g."membershipId" AND m."accountId"=g."accountId"
 WHERE g."orgId"=NEW."orgId" AND g."accountId"=actor AND g."personId"=NEW."recordedByPersonId" AND g.capability='opportunity.maintain'
 AND m."projectId" IS NULL AND m."activeFrom"<=NEW."recordedAt" AND (m."activeUntil" IS NULL OR m."activeUntil">NEW."recordedAt")
 AND g."validFrom"<=NEW."recordedAt" AND g."validUntil">NEW."recordedAt"
 AND NOT EXISTS(SELECT 1 FROM public."OpportunityGrantRevocation" r WHERE r."orgId"=g."orgId" AND r."grantId"=g.id)
 ORDER BY least(g."validUntil",coalesce(m."activeUntil",g."validUntil")) DESC,g.id LIMIT 1;
 IF mid IS NULL THEN RAISE EXCEPTION 'opportunity creation grant is not admitted'; END IF;
 INSERT INTO public."OpportunityGrant"(id,"orgId","membershipId","accountId","personId",capability,scope,"opportunityId","validFrom","validUntil",basis,source,"grantedBy")
 SELECT gen_random_uuid(),NEW."orgId",mid,actor,NEW."recordedByPersonId",cap,'OPPORTUNITY',NEW."opportunityId",NEW."recordedAt",until_time,'Q6: explicit revocable creation grant','system:opportunity.create',actor
 FROM unnest(ARRAY['opportunity.maintain','opportunity.internal']) cap;
 RETURN NULL; END $$;
CREATE TRIGGER opportunity_create_grants AFTER INSERT ON "OpportunityRecord" FOR EACH ROW EXECUTE FUNCTION opportunity_create_grants();
REVOKE ALL ON FUNCTION opportunity_create_grants() FROM PUBLIC;

ALTER TABLE "Opportunity" ENABLE ROW LEVEL SECURITY;
CREATE POLICY opportunity_org ON "Opportunity" TO mje_alpha_app USING("orgId"::text=current_setting('app.org_id',true)) WITH CHECK("orgId"::text=current_setting('app.org_id',true));
GRANT SELECT,INSERT ON "Opportunity" TO mje_alpha_app;
GRANT UPDATE(version,"updatedAt","updatedBy") ON "Opportunity" TO mje_alpha_app;
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['OpportunityRecord','OpportunityRecordPerson','OpportunityRecordCompany','OpportunityRecordSource','OpportunityGrant','OpportunityGrantRevocation'] LOOP
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION contract_register_append_only()',t||'_append_only',t);
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY opportunity_org ON %I TO mje_alpha_app USING("orgId"::text=current_setting(''app.org_id'',true)) WITH CHECK("orgId"::text=current_setting(''app.org_id'',true))',t);
 EXECUTE format('GRANT SELECT ON %I TO mje_alpha_app',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['OpportunityRecord','OpportunityRecordPerson','OpportunityRecordCompany','OpportunityRecordSource'] LOOP
 EXECUTE format('GRANT INSERT ON %I TO mje_alpha_app',t);
 END LOOP;
END $$;
