-- Additive DG05-1b; prior header migration and legacy scope identities remain intact.
ALTER TABLE "ContractRevision"
 ADD COLUMN "counterpartyCompanyId" UUID, ADD COLUMN "selfCompanyId" UUID,
 ADD COLUMN "signedOnState" TEXT NOT NULL DEFAULT 'UNKNOWN', ADD COLUMN "signedOn" DATE,
 ADD COLUMN "effectiveOnState" TEXT NOT NULL DEFAULT 'UNKNOWN', ADD COLUMN "effectiveOn" DATE,
 ADD COLUMN "registrationStatus" TEXT NOT NULL DEFAULT 'SIGNED_PENDING', ADD COLUMN "taxBasis" TEXT NOT NULL DEFAULT 'UNKNOWN',
 ADD COLUMN "partiesSourceId" UUID,ADD COLUMN "partiesLocation" TEXT,
 ADD COLUMN "datesSourceId" UUID,ADD COLUMN "datesLocation" TEXT,
 ADD COLUMN "totalSourceId" UUID,ADD COLUMN "totalLocation" TEXT,
 ADD CHECK("signedOnState" IN ('VALUE','UNKNOWN','NOT_STATED') AND (("signedOnState"='VALUE')=("signedOn" IS NOT NULL))),
 ADD CHECK("effectiveOnState" IN ('VALUE','UNKNOWN','NOT_STATED') AND (("effectiveOnState"='VALUE')=("effectiveOn" IS NOT NULL))),
 ADD CHECK("registrationStatus" IN ('SIGNED_PENDING','EFFECTIVE')),
 ADD CHECK("taxBasis" IN ('INCLUSIVE','EXCLUSIVE','UNKNOWN')),
 ADD FOREIGN KEY("orgId","counterpartyCompanyId") REFERENCES "Company"("orgId",id) ON DELETE RESTRICT,
 ADD FOREIGN KEY("orgId","selfCompanyId") REFERENCES "Company"("orgId",id) ON DELETE RESTRICT,
 ADD FOREIGN KEY("orgId","partiesSourceId") REFERENCES "SourceDocument"("orgId",id) ON DELETE RESTRICT,
 ADD FOREIGN KEY("orgId","datesSourceId") REFERENCES "SourceDocument"("orgId",id) ON DELETE RESTRICT,
 ADD FOREIGN KEY("orgId","totalSourceId") REFERENCES "SourceDocument"("orgId",id) ON DELETE RESTRICT;
CREATE TABLE "ContractLine" (
 id UUID PRIMARY KEY,"orgId" UUID NOT NULL,"contractId" UUID NOT NULL,
 UNIQUE("orgId",id),UNIQUE("orgId","contractId",id),
 FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","contractId") REFERENCES "Contract"("orgId",id) ON DELETE RESTRICT
);
CREATE TABLE "ContractLineRevision" (
 id UUID PRIMARY KEY,"orgId" UUID NOT NULL,"contractId" UUID NOT NULL,"lineId" UUID NOT NULL,n INTEGER NOT NULL,
 "lineNo" TEXT NOT NULL CHECK(btrim("lineNo")<>''),description TEXT NOT NULL CHECK(btrim(description)<>''),
 "quantityState" TEXT NOT NULL CHECK("quantityState" IN ('VALUE','BLANK','UNKNOWN','NA','NOT_STATED')),quantity DECIMAL(20,6),
 "unitRaw" TEXT NOT NULL,unit TEXT CHECK(unit IN ('pcs','set','m','day','kWp')),
 "pricingType" TEXT NOT NULL CHECK("pricingType" IN ('LUMP_SUM','UNIT_PRICE','TIME_AND_MATERIAL','REIMBURSABLE','UNKNOWN')),
 "amountState" TEXT NOT NULL CHECK("amountState" IN ('VALUE','BLANK','UNKNOWN','NA','NOT_STATED')),amount DECIMAL(20,4),
 includes TEXT NOT NULL,excludes TEXT NOT NULL,derivation TEXT NOT NULL,
 "sourceDocumentId" UUID,location TEXT,removed BOOLEAN NOT NULL DEFAULT false,"removalSourceDocumentId" UUID,"removalLocation" TEXT,
 UNIQUE("orgId",id),UNIQUE("orgId","contractId","lineId",n),UNIQUE("orgId","contractId",n,"lineNo"),
 CHECK(("quantityState"='VALUE')=(quantity IS NOT NULL)),CHECK(quantity>=0),CHECK(("amountState"='VALUE')=(amount IS NOT NULL)),
 CHECK(("sourceDocumentId" IS NULL)=(location IS NULL)),CHECK(("removalSourceDocumentId" IS NULL)=("removalLocation" IS NULL)),
 FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","contractId","lineId") REFERENCES "ContractLine"("orgId","contractId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","contractId",n) REFERENCES "ContractRevision"("orgId","contractId",n) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","sourceDocumentId") REFERENCES "SourceDocument"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","removalSourceDocumentId") REFERENCES "SourceDocument"("orgId",id) ON DELETE RESTRICT
);
ALTER TABLE "ContractScope" ADD COLUMN "contractId" UUID,ADD COLUMN "contractLineId" UUID,
 ADD UNIQUE("orgId","contractId","contractLineId",id),ADD UNIQUE("orgId","contractLineId","projectId"),
 ADD CHECK(("contractId" IS NULL)=("contractLineId" IS NULL)),ADD CHECK("contractLineId" IS NULL OR amount IS NULL),
 ADD FOREIGN KEY("orgId","contractId","contractLineId") REFERENCES "ContractLine"("orgId","contractId",id) ON DELETE RESTRICT;
CREATE TABLE "ContractScopeVersion" (
 id UUID PRIMARY KEY,"orgId" UUID NOT NULL,"contractId" UUID NOT NULL,"lineId" UUID NOT NULL,"scopeId" UUID NOT NULL,
 n INTEGER NOT NULL CHECK(n>0),"contractRevisionN" INTEGER NOT NULL,
 basis TEXT NOT NULL CHECK(basis IN ('WHOLE','QUANTITY','AREA','NOTE')),quantity DECIMAL(20,6),area TEXT NOT NULL,note TEXT NOT NULL,
 retired BOOLEAN NOT NULL DEFAULT false,reason TEXT NOT NULL,"registeredBy" UUID NOT NULL,"registeredByPersonId" UUID NOT NULL,
 "registeredAt" TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE("orgId",id),UNIQUE("orgId","scopeId",n),
 CHECK((basis='QUANTITY')=(quantity IS NOT NULL)),CHECK(quantity>0),CHECK(basis<>'AREA' OR btrim(area)<>''),CHECK(basis<>'NOTE' OR btrim(note)<>''),CHECK(NOT retired OR btrim(reason)<>''),
 FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","contractId","lineId","scopeId") REFERENCES "ContractScope"("orgId","contractId","contractLineId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","contractId","lineId","contractRevisionN") REFERENCES "ContractLineRevision"("orgId","contractId","lineId",n) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","registeredBy") REFERENCES "LoginAccount"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","registeredByPersonId") REFERENCES "Person"("orgId",id) ON DELETE RESTRICT
);
CREATE TABLE "ContractAttention" (
 id UUID PRIMARY KEY,"orgId" UUID NOT NULL,"contractId" UUID NOT NULL,"revisionN" INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('UNASSIGNED','CORRECTION','SHARE_MISASSIGNED')),"causedByPersonId" UUID NOT NULL,"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 "involvedPersonIds" UUID[] NOT NULL DEFAULT '{}',
 UNIQUE("orgId",id),
 FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","contractId","revisionN") REFERENCES "ContractRevision"("orgId","contractId",n) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","causedByPersonId") REFERENCES "Person"("orgId",id) ON DELETE RESTRICT
);
CREATE TABLE "ContractAttentionRead" (
 id UUID PRIMARY KEY,"orgId" UUID NOT NULL,"attentionId" UUID NOT NULL,"byAccountId" UUID NOT NULL,"byPersonId" UUID NOT NULL,at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE("orgId",id),UNIQUE("orgId","attentionId","byAccountId"),
 FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","attentionId") REFERENCES "ContractAttention"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","byAccountId") REFERENCES "LoginAccount"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","byPersonId") REFERENCES "Person"("orgId",id) ON DELETE RESTRICT
);
-- Preserve old scope rows; new contract-linked identities and all versions are immutable.
CREATE FUNCTION contract_scope_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF OLD."contractLineId" IS NOT NULL OR (TG_OP='UPDATE' AND NEW."contractLineId" IS NOT NULL) THEN RAISE EXCEPTION 'contract scope identity is immutable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER contract_scope_identity BEFORE UPDATE OR DELETE ON "ContractScope" FOR EACH ROW EXECUTE FUNCTION contract_scope_identity();
REVOKE ALL ON FUNCTION contract_scope_identity() FROM PUBLIC;
GRANT INSERT ON "Contract","ContractRevision","ContractRevisionSource","ContractScope" TO mje_alpha_app;
CREATE TRIGGER "ContractLine_append_only" BEFORE UPDATE OR DELETE ON "ContractLine" FOR EACH ROW EXECUTE FUNCTION contract_register_append_only();
ALTER TABLE "ContractLine" ENABLE ROW LEVEL SECURITY;
CREATE POLICY alpha_org ON "ContractLine" TO mje_alpha_app USING("orgId"::text=current_setting('app.org_id',true)) WITH CHECK("orgId"::text=current_setting('app.org_id',true));
GRANT SELECT,INSERT ON "ContractLine" TO mje_alpha_app;
CREATE TRIGGER "ContractLineRevision_append_only" BEFORE UPDATE OR DELETE ON "ContractLineRevision" FOR EACH ROW EXECUTE FUNCTION contract_register_append_only();
ALTER TABLE "ContractLineRevision" ENABLE ROW LEVEL SECURITY;
CREATE POLICY alpha_org ON "ContractLineRevision" TO mje_alpha_app USING("orgId"::text=current_setting('app.org_id',true)) WITH CHECK("orgId"::text=current_setting('app.org_id',true));
GRANT SELECT,INSERT ON "ContractLineRevision" TO mje_alpha_app;
CREATE TRIGGER "ContractScopeVersion_append_only" BEFORE UPDATE OR DELETE ON "ContractScopeVersion" FOR EACH ROW EXECUTE FUNCTION contract_register_append_only();
ALTER TABLE "ContractScopeVersion" ENABLE ROW LEVEL SECURITY;
CREATE POLICY alpha_org ON "ContractScopeVersion" TO mje_alpha_app USING("orgId"::text=current_setting('app.org_id',true)) WITH CHECK("orgId"::text=current_setting('app.org_id',true));
GRANT SELECT,INSERT ON "ContractScopeVersion" TO mje_alpha_app;
CREATE TRIGGER "ContractAttention_append_only" BEFORE UPDATE OR DELETE ON "ContractAttention" FOR EACH ROW EXECUTE FUNCTION contract_register_append_only();
ALTER TABLE "ContractAttention" ENABLE ROW LEVEL SECURITY;
CREATE POLICY alpha_org ON "ContractAttention" TO mje_alpha_app USING("orgId"::text=current_setting('app.org_id',true)) WITH CHECK("orgId"::text=current_setting('app.org_id',true));
GRANT SELECT,INSERT ON "ContractAttention" TO mje_alpha_app;
CREATE TRIGGER "ContractAttentionRead_append_only" BEFORE UPDATE OR DELETE ON "ContractAttentionRead" FOR EACH ROW EXECUTE FUNCTION contract_register_append_only();
ALTER TABLE "ContractAttentionRead" ENABLE ROW LEVEL SECURITY;
CREATE POLICY alpha_org ON "ContractAttentionRead" TO mje_alpha_app USING("orgId"::text=current_setting('app.org_id',true)) WITH CHECK("orgId"::text=current_setting('app.org_id',true));
GRANT SELECT,INSERT ON "ContractAttentionRead" TO mje_alpha_app;
DROP POLICY alpha_org ON "Contract";
CREATE POLICY alpha_org ON "Contract" TO mje_alpha_app USING("orgId"::text=current_setting('app.org_id',true)) WITH CHECK("orgId"::text=current_setting('app.org_id',true));
DROP POLICY alpha_org ON "ContractRevision";
CREATE POLICY alpha_org ON "ContractRevision" TO mje_alpha_app USING("orgId"::text=current_setting('app.org_id',true)) WITH CHECK("orgId"::text=current_setting('app.org_id',true));
DROP POLICY alpha_org ON "ContractRevisionSource";
CREATE POLICY alpha_org ON "ContractRevisionSource" TO mje_alpha_app USING("orgId"::text=current_setting('app.org_id',true)) WITH CHECK("orgId"::text=current_setting('app.org_id',true));
-- Provenance stays within this contract version, including line removal evidence.
ALTER TABLE "ContractRevision"
 ADD CHECK (("partiesSourceId" IS NULL)=("partiesLocation" IS NULL)),
 ADD CHECK (("datesSourceId" IS NULL)=("datesLocation" IS NULL)),
 ADD CHECK (("totalSourceId" IS NULL)=("totalLocation" IS NULL)),
 ADD CHECK ("partiesLocation" IS NULL OR btrim("partiesLocation")<>''),
 ADD CHECK ("datesLocation" IS NULL OR btrim("datesLocation")<>''),
 ADD CHECK ("totalLocation" IS NULL OR btrim("totalLocation")<>'');
ALTER TABLE "ContractLineRevision"
 ADD CHECK (location IS NULL OR btrim(location)<>''),
 ADD CHECK ("removalLocation" IS NULL OR btrim("removalLocation")<>''),
 ADD CHECK (NOT removed OR "removalSourceDocumentId" IS NOT NULL);
ALTER TABLE "ContractScope" ADD CHECK("contractLineId" IS NULL OR "pricingType"='UNKNOWN');
CREATE FUNCTION contract_revision_source_binding() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE doc UUID;
BEGIN
 IF TG_TABLE_NAME='ContractRevision' THEN
  FOREACH doc IN ARRAY ARRAY[NEW."partiesSourceId",NEW."datesSourceId",NEW."totalSourceId"] LOOP
   IF doc IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public."ContractRevisionSource" s WHERE s."orgId"=NEW."orgId" AND s."contractId"=NEW."contractId" AND s.n=NEW.n AND s."sourceDocumentId"=doc) THEN RAISE EXCEPTION 'contract version source binding invalid' USING ERRCODE='23514'; END IF;
  END LOOP;
 ELSE
  FOREACH doc IN ARRAY ARRAY[NEW."sourceDocumentId",NEW."removalSourceDocumentId"] LOOP
   IF doc IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public."ContractRevisionSource" s WHERE s."orgId"=NEW."orgId" AND s."contractId"=NEW."contractId" AND s.n=NEW.n AND s."sourceDocumentId"=doc) THEN RAISE EXCEPTION 'contract version source binding invalid' USING ERRCODE='23514'; END IF;
  END LOOP;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER contract_revision_source_binding AFTER INSERT ON "ContractRevision" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION contract_revision_source_binding();
CREATE CONSTRAINT TRIGGER contract_line_source_binding AFTER INSERT ON "ContractLineRevision" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION contract_revision_source_binding();
REVOKE ALL ON FUNCTION contract_revision_source_binding() FROM PUBLIC;
