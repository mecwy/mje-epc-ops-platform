-- U2.1 Site Daily Close core (additive). Facts are stored as JSON on a draft row; submitted
-- versions are frozen in the existing Revision table. Plans are versioned per target day.
-- Existing Alpha tables, roles and policies are untouched.

CREATE TABLE "DailyReportDraft" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL REFERENCES "Organization"("id") ON DELETE RESTRICT,
  "dailyCloseId" UUID NOT NULL,
  "facts" JSONB NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedBy" UUID NOT NULL,
  CONSTRAINT "DailyReportDraft_orgId_id_key" UNIQUE ("orgId", "id"),
  CONSTRAINT "DailyReportDraft_orgId_dailyCloseId_key" UNIQUE ("orgId", "dailyCloseId"),
  CONSTRAINT "DailyReportDraft_dailyClose_fkey" FOREIGN KEY ("orgId", "dailyCloseId") REFERENCES "DailyClose"("orgId", "id") ON DELETE RESTRICT,
  CONSTRAINT "DailyReportDraft_actor_fkey" FOREIGN KEY ("orgId", "updatedBy") REFERENCES "LoginAccount"("orgId", "id") ON DELETE RESTRICT
);

-- A non-null reason marks a submitted day that is being corrected; it is cleared when the
-- correction is submitted as the next revision or cancelled.
ALTER TABLE "DailyClose" ADD COLUMN "correctionReason" TEXT;

CREATE TABLE "PlanVersion" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL REFERENCES "Organization"("id") ON DELETE RESTRICT,
  "projectId" UUID NOT NULL,
  "targetBusinessDate" DATE NOT NULL,
  "number" INTEGER NOT NULL,
  "rows" JSONB NOT NULL,
  "confirmedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "confirmedBy" UUID NOT NULL,
  CONSTRAINT "PlanVersion_orgId_id_key" UNIQUE ("orgId", "id"),
  CONSTRAINT "PlanVersion_target_number_key" UNIQUE ("orgId", "projectId", "targetBusinessDate", "number"),
  CONSTRAINT "PlanVersion_project_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT,
  CONSTRAINT "PlanVersion_actor_fkey" FOREIGN KEY ("orgId", "confirmedBy") REFERENCES "LoginAccount"("orgId", "id") ON DELETE RESTRICT
);

CREATE TABLE "PlanDraft" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL REFERENCES "Organization"("id") ON DELETE RESTRICT,
  "projectId" UUID NOT NULL,
  "targetBusinessDate" DATE NOT NULL,
  "rows" JSONB NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedBy" UUID NOT NULL,
  CONSTRAINT "PlanDraft_orgId_id_key" UNIQUE ("orgId", "id"),
  CONSTRAINT "PlanDraft_target_key" UNIQUE ("orgId", "projectId", "targetBusinessDate"),
  CONSTRAINT "PlanDraft_project_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT,
  CONSTRAINT "PlanDraft_actor_fkey" FOREIGN KEY ("orgId", "updatedBy") REFERENCES "LoginAccount"("orgId", "id") ON DELETE RESTRICT
);

-- Per-project report master rows: work items (the 9 installation rows), machinery and
-- materials. Quantities are reported text: '' | 'unknown' | 'na' | decimal, never a float.
CREATE TABLE "ReportItem" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL REFERENCES "Organization"("id") ON DELETE RESTRICT,
  "projectId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "unit" TEXT NOT NULL DEFAULT '',
  "designQty" TEXT NOT NULL DEFAULT '',
  "openingCumulative" TEXT NOT NULL DEFAULT '',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedBy" UUID NOT NULL,
  CONSTRAINT "ReportItem_orgId_id_key" UNIQUE ("orgId", "id"),
  CONSTRAINT "ReportItem_project_kind_key_key" UNIQUE ("orgId", "projectId", "kind", "key"),
  CONSTRAINT "ReportItem_project_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT,
  CONSTRAINT "ReportItem_kind_check" CHECK ("kind" IN ('work', 'machinery', 'material')),
  CONSTRAINT "ReportItem_key_check" CHECK ("key" ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$')
);

-- The same application role as the Alpha slice; RLS keeps every row inside the caller's org.
GRANT SELECT, INSERT, UPDATE ON "DailyReportDraft", "ReportItem" TO mje_alpha_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "PlanDraft" TO mje_alpha_app;
GRANT SELECT, INSERT ON "PlanVersion" TO mje_alpha_app;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['DailyReportDraft', 'PlanVersion', 'PlanDraft', 'ReportItem'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY alpha_org ON %I TO mje_alpha_app USING ("orgId"::text = current_setting(''app.org_id'', true)) WITH CHECK ("orgId"::text = current_setting(''app.org_id'', true))', table_name);
  END LOOP;
END $$;
