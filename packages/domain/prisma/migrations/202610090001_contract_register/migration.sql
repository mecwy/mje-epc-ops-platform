-- DG05-1a: explicit grants + read-only header register. No role fallback or app grant writer.
CREATE TABLE "ContractGrant" (
 id UUID PRIMARY KEY,"orgId" UUID NOT NULL,"membershipId" UUID NOT NULL,"accountId" UUID NOT NULL,"personId" UUID NOT NULL,
 capability TEXT NOT NULL CHECK(capability IN ('contract.view','contract.amount','contract.terms','contract.original','contract.internal','contract.maintain','contract.attention')),
 direction TEXT NOT NULL CHECK(direction IN ('ALL','INCOME','EXPENDITURE')),
 scope TEXT NOT NULL CHECK(scope IN ('ORG','PROJECT')),"projectId" UUID,
 "validFrom" TIMESTAMPTZ NOT NULL,"validUntil" TIMESTAMPTZ NOT NULL CHECK("validUntil">"validFrom"),
 basis TEXT NOT NULL CHECK(btrim(basis)<>''),source TEXT NOT NULL CHECK(btrim(source)<>''),"templateVersion" TEXT,
 "grantedBy" UUID NOT NULL,"grantedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),"representedPersonId" UUID,"delegationBasis" TEXT,
 UNIQUE("orgId",id), CHECK((scope='ORG')=("projectId" IS NULL)),
 CHECK(("representedPersonId" IS NULL)=("delegationBasis" IS NULL)),CHECK("delegationBasis" IS NULL OR btrim("delegationBasis")<>''),
 FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","membershipId") REFERENCES "Membership"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","accountId") REFERENCES "LoginAccount"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","personId") REFERENCES "Person"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","projectId") REFERENCES "Project"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","grantedBy") REFERENCES "LoginAccount"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","representedPersonId") REFERENCES "Person"("orgId",id) ON DELETE RESTRICT
);
CREATE TABLE "ContractGrantRevocation" (
 id UUID PRIMARY KEY,"orgId" UUID NOT NULL,"grantId" UUID NOT NULL,"revokedBy" UUID NOT NULL,
 reason TEXT NOT NULL CHECK(btrim(reason)<>''),at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE("orgId",id),UNIQUE("orgId","grantId"),
 FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","grantId") REFERENCES "ContractGrant"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","revokedBy") REFERENCES "LoginAccount"("orgId",id) ON DELETE RESTRICT
);
CREATE TABLE "Contract" (
 id UUID PRIMARY KEY,"orgId" UUID NOT NULL,code TEXT NOT NULL CHECK(btrim(code)<>''),
 direction TEXT NOT NULL CHECK(direction IN ('INCOME','EXPENDITURE')),"expenditureSubtype" TEXT,
 "createdBy" UUID NOT NULL,"createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE("orgId",id),UNIQUE("orgId",code),
 CHECK((direction='INCOME' AND "expenditureSubtype" IS NULL) OR (direction='EXPENDITURE' AND "expenditureSubtype" IS NOT NULL AND "expenditureSubtype" IN ('SUBCONTRACT','PURCHASE'))),
 FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","createdBy") REFERENCES "LoginAccount"("orgId",id) ON DELETE RESTRICT
);
CREATE TABLE "ContractRevision" (
 id UUID PRIMARY KEY,"orgId" UUID NOT NULL,"contractId" UUID NOT NULL,n INTEGER NOT NULL CHECK(n>0),
 name TEXT NOT NULL CHECK(btrim(name)<>''),"originalNumber" TEXT,"counterpartyRaw" TEXT,"selfPartyRaw" TEXT,
 "informationOwnerPersonId" UUID,"totalState" TEXT NOT NULL CHECK("totalState" IN ('VALUE','BLANK','UNKNOWN','NA','NOT_STATED')),
 "totalAmount" DECIMAL(20,4),currency CHAR(3),"correctionReason" TEXT,
 "registeredBy" UUID NOT NULL,"registeredByPersonId" UUID NOT NULL,"registeredAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE("orgId",id),UNIQUE("orgId","contractId",n),
 CHECK(("totalState"='VALUE')=("totalAmount" IS NOT NULL)),CHECK("totalAmount">=0),
 CHECK(currency IS NULL OR currency ~ '^[A-Z]{3}$'),CHECK("totalState"<>'VALUE' OR currency IS NOT NULL),
 CHECK((n=1 AND "correctionReason" IS NULL) OR (n>1 AND "correctionReason" IS NOT NULL AND btrim("correctionReason")<>'')),
 FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","contractId") REFERENCES "Contract"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","informationOwnerPersonId") REFERENCES "Person"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","registeredBy") REFERENCES "LoginAccount"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","registeredByPersonId") REFERENCES "Person"("orgId",id) ON DELETE RESTRICT
);
CREATE TABLE "ContractRevisionSource" (
 id UUID PRIMARY KEY,"orgId" UUID NOT NULL,"contractId" UUID NOT NULL,n INTEGER NOT NULL,"sourceDocumentId" UUID NOT NULL,
 location TEXT NOT NULL CHECK(btrim(location)<>''),
 UNIQUE("orgId",id),UNIQUE("orgId","contractId",n,"sourceDocumentId",location),
 FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","contractId",n) REFERENCES "ContractRevision"("orgId","contractId",n) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","sourceDocumentId") REFERENCES "SourceDocument"("orgId",id) ON DELETE RESTRICT
);
CREATE FUNCTION contract_register_append_only() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN RAISE EXCEPTION 'contract register history is append-only'; END $$;
CREATE FUNCTION contract_grant_version() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target UUID;
BEGIN
 IF TG_TABLE_NAME='ContractGrant' THEN target:=NEW."accountId";
 ELSE SELECT g."accountId" INTO target FROM public."ContractGrant" g WHERE g."orgId"=NEW."orgId" AND g.id=NEW."grantId"; END IF;
 UPDATE public."LoginAccount" SET "authzVersion"="authzVersion"+1 WHERE "orgId"=NEW."orgId" AND id=target;
 RETURN NULL;
END $$;
CREATE TRIGGER contract_grant_version AFTER INSERT ON "ContractGrant" FOR EACH ROW EXECUTE FUNCTION contract_grant_version();
CREATE TRIGGER contract_revoke_version AFTER INSERT ON "ContractGrantRevocation" FOR EACH ROW EXECUTE FUNCTION contract_grant_version();
REVOKE ALL ON FUNCTION contract_register_append_only(),contract_grant_version() FROM PUBLIC;
CREATE TRIGGER "ContractGrant_append_only" BEFORE UPDATE OR DELETE ON "ContractGrant" FOR EACH ROW EXECUTE FUNCTION contract_register_append_only();
ALTER TABLE "ContractGrant" ENABLE ROW LEVEL SECURITY;
CREATE POLICY alpha_org ON "ContractGrant" TO mje_alpha_app USING("orgId"::text=current_setting('app.org_id',true));
GRANT SELECT ON "ContractGrant" TO mje_alpha_app;
CREATE TRIGGER "ContractGrantRevocation_append_only" BEFORE UPDATE OR DELETE ON "ContractGrantRevocation" FOR EACH ROW EXECUTE FUNCTION contract_register_append_only();
ALTER TABLE "ContractGrantRevocation" ENABLE ROW LEVEL SECURITY;
CREATE POLICY alpha_org ON "ContractGrantRevocation" TO mje_alpha_app USING("orgId"::text=current_setting('app.org_id',true));
GRANT SELECT ON "ContractGrantRevocation" TO mje_alpha_app;
CREATE TRIGGER "Contract_append_only" BEFORE UPDATE OR DELETE ON "Contract" FOR EACH ROW EXECUTE FUNCTION contract_register_append_only();
ALTER TABLE "Contract" ENABLE ROW LEVEL SECURITY;
CREATE POLICY alpha_org ON "Contract" TO mje_alpha_app USING("orgId"::text=current_setting('app.org_id',true));
GRANT SELECT ON "Contract" TO mje_alpha_app;
CREATE TRIGGER "ContractRevision_append_only" BEFORE UPDATE OR DELETE ON "ContractRevision" FOR EACH ROW EXECUTE FUNCTION contract_register_append_only();
ALTER TABLE "ContractRevision" ENABLE ROW LEVEL SECURITY;
CREATE POLICY alpha_org ON "ContractRevision" TO mje_alpha_app USING("orgId"::text=current_setting('app.org_id',true));
GRANT SELECT ON "ContractRevision" TO mje_alpha_app;
CREATE TRIGGER "ContractRevisionSource_append_only" BEFORE UPDATE OR DELETE ON "ContractRevisionSource" FOR EACH ROW EXECUTE FUNCTION contract_register_append_only();
ALTER TABLE "ContractRevisionSource" ENABLE ROW LEVEL SECURITY;
CREATE POLICY alpha_org ON "ContractRevisionSource" TO mje_alpha_app USING("orgId"::text=current_setting('app.org_id',true));
GRANT SELECT ON "ContractRevisionSource" TO mje_alpha_app;
