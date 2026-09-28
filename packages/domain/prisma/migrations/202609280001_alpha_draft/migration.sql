-- Additive owner-Alpha slice. Existing Revision and AuditLog immutability remains in force.
CREATE TABLE "AlphaDraft" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL REFERENCES "Organization"("id") ON DELETE RESTRICT,
  "dailyCloseId" UUID NOT NULL,
  "content" JSONB NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedBy" UUID NOT NULL,
  CONSTRAINT "AlphaDraft_orgId_id_key" UNIQUE ("orgId", "id"),
  CONSTRAINT "AlphaDraft_orgId_dailyCloseId_key" UNIQUE ("orgId", "dailyCloseId"),
  CONSTRAINT "AlphaDraft_dailyClose_fkey" FOREIGN KEY ("orgId", "dailyCloseId") REFERENCES "DailyClose"("orgId", "id") ON DELETE RESTRICT,
  CONSTRAINT "AlphaDraft_actor_fkey" FOREIGN KEY ("orgId", "updatedBy") REFERENCES "LoginAccount"("orgId", "id") ON DELETE RESTRICT
);

-- A group role only. Cloud Entra and local TEST logins are provisioned separately.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mje_alpha_app') THEN
    CREATE ROLE mje_alpha_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO mje_alpha_app;
GRANT SELECT ON "LoginAccount", "Membership", "Project" TO mje_alpha_app;
GRANT SELECT, INSERT, UPDATE ON "DailyClose", "AlphaDraft", "IdempotencyRecord" TO mje_alpha_app;
GRANT SELECT, INSERT ON "Revision" TO mje_alpha_app;
GRANT INSERT ON "AuditLog", "RevisionEvent" TO mje_alpha_app;

ALTER TABLE "LoginAccount" ENABLE ROW LEVEL SECURITY;
CREATE POLICY alpha_identity ON "LoginAccount" TO mje_alpha_app
  USING (active AND "entraTenantId" = current_setting('app.tenant_id', true)
    AND "entraObjectId" = current_setting('app.object_id', true));
ALTER TABLE "Membership" ENABLE ROW LEVEL SECURITY;
CREATE POLICY alpha_membership ON "Membership" TO mje_alpha_app
  USING (EXISTS (SELECT 1 FROM "LoginAccount" a
    WHERE a.id = "Membership"."accountId" AND a."orgId" = "Membership"."orgId"));

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['Project', 'DailyClose', 'AlphaDraft', 'Revision', 'RevisionEvent', 'AuditLog', 'IdempotencyRecord'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY alpha_org ON %I TO mje_alpha_app USING ("orgId"::text = current_setting(''app.org_id'', true)) WITH CHECK ("orgId"::text = current_setting(''app.org_id'', true))', table_name);
  END LOOP;
END $$;
-- Owner/migration identity intentionally retains recovery rights; it must never be the web login.
