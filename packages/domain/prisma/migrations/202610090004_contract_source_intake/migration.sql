-- Explicit direction classification for controlled contract intake; no app write permission.
CREATE TABLE "ContractSourceIntake" (
 id UUID PRIMARY KEY, "orgId" UUID NOT NULL, "sourceDocumentId" UUID NOT NULL,
 direction TEXT NOT NULL CHECK(direction IN ('INCOME','EXPENDITURE')),
 basis TEXT NOT NULL CHECK(btrim(basis)<>''), "registeredBy" UUID NOT NULL,
 "registeredAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE("orgId",id), UNIQUE("orgId","sourceDocumentId",direction),
 FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","sourceDocumentId") REFERENCES "SourceDocument"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","registeredBy") REFERENCES "LoginAccount"("orgId",id) ON DELETE RESTRICT
);
CREATE TRIGGER "ContractSourceIntake_append_only" BEFORE UPDATE OR DELETE ON "ContractSourceIntake"
 FOR EACH ROW EXECUTE FUNCTION contract_register_append_only();
ALTER TABLE "ContractSourceIntake" ENABLE ROW LEVEL SECURITY;
CREATE POLICY alpha_org ON "ContractSourceIntake" TO mje_alpha_app
 USING("orgId"::text=current_setting('app.org_id',true));
GRANT SELECT ON "ContractSourceIntake" TO mje_alpha_app;
