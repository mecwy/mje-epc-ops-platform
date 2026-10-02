-- Separate repair after the prior migration was exercised in a disposable TEST database.
-- Tenant RLS guards existing scope identities and reference-only master/source reads.
ALTER TABLE "ContractScope" ENABLE ROW LEVEL SECURITY;
CREATE POLICY contract_reference_org ON "ContractScope" TO mje_alpha_app
 USING("orgId"::text=current_setting('app.org_id',true))
 WITH CHECK("orgId"::text=current_setting('app.org_id',true));
GRANT SELECT ON "ContractScope" TO mje_alpha_app;
ALTER TABLE "Company" ENABLE ROW LEVEL SECURITY;
CREATE POLICY contract_reference_org ON "Company" TO mje_alpha_app
 USING("orgId"::text=current_setting('app.org_id',true));
GRANT SELECT ON "Company" TO mje_alpha_app;
ALTER TABLE "SourceDocument" ENABLE ROW LEVEL SECURITY;
CREATE POLICY contract_reference_org ON "SourceDocument" TO mje_alpha_app
 USING("orgId"::text=current_setting('app.org_id',true));
GRANT SELECT ON "SourceDocument" TO mje_alpha_app;
