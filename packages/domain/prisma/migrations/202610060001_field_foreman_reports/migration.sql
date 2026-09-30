-- A6c foreman quantity reports and PM adoption (additive; design: docs/architecture/a6-field-devices-design.md §4, §5, §7).
-- A foreman report is a claim: one header per (project, business day, crew) with insert-only
-- numbered revisions. The PM adopts a complete total explicitly; every adoption is an
-- append-only row with the exact basis it was decided on. Nothing here fills report facts on
-- its own, and no hours are recorded. Depends on "FieldDay" (202610040001) for the day sequence.

-- ---------- reports ----------
CREATE TABLE "ForemanReport" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "crewId" UUID NOT NULL,
  "businessDate" DATE NOT NULL,
  -- The latest revision number; moves forward by exactly one per revision.
  "currentN" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "ForemanReport_orgId_projectId_crewId_fkey" FOREIGN KEY ("orgId", "projectId", "crewId") REFERENCES "Crew"("orgId", "projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ForemanReport_currentN_check" CHECK ("currentN" >= 1)
);
CREATE UNIQUE INDEX "ForemanReport_orgId_projectId_id_key" ON "ForemanReport"("orgId", "projectId", "id");
CREATE UNIQUE INDEX "ForemanReport_orgId_projectId_businessDate_crewId_key" ON "ForemanReport"("orgId", "projectId", "businessDate", "crewId");
CREATE FUNCTION foreman_report_forward_only() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'foreman reports are never deleted'; END IF;
  IF (pg_catalog.to_jsonb(NEW) - 'currentN') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'currentN')
    OR NEW."currentN" <> OLD."currentN" + 1 THEN
    RAISE EXCEPTION 'a foreman report only moves to its next revision';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER foreman_report_forward_only BEFORE UPDATE OR DELETE ON "ForemanReport"
  FOR EACH ROW EXECUTE FUNCTION foreman_report_forward_only();

-- Insert-only. Rows are [{itemKey, qty}] with qty a decimal string, 'unknown', 'na' or '' (a
-- blank is stored, not dropped). Occurred (device), received (decision time) and recorded
-- (insert) times are kept apart; daySeq is the day's field sequence (submission boundary).
CREATE TABLE "ForemanReportRevision" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "reportId" UUID NOT NULL,
  "n" INTEGER NOT NULL,
  "rows" JSONB NOT NULL,
  "note" TEXT NOT NULL,
  "byPersonId" UUID NOT NULL,
  "byDeviceId" UUID NOT NULL,
  "occurredAt" TIMESTAMPTZ(6) NOT NULL,
  "receivedAt" TIMESTAMPTZ(6) NOT NULL,
  "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "siteTimezone" TEXT NOT NULL,
  "daySeq" BIGINT NOT NULL,
  CONSTRAINT "ForemanReportRevision_orgId_projectId_reportId_fkey" FOREIGN KEY ("orgId", "projectId", "reportId") REFERENCES "ForemanReport"("orgId", "projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ForemanReportRevision_orgId_byPersonId_fkey" FOREIGN KEY ("orgId", "byPersonId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ForemanReportRevision_orgId_projectId_byDeviceId_fkey" FOREIGN KEY ("orgId", "projectId", "byDeviceId") REFERENCES "FieldDevice"("orgId", "projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ForemanReportRevision_n_check" CHECK ("n" >= 1),
  CONSTRAINT "ForemanReportRevision_rows_check" CHECK (jsonb_typeof("rows") = 'array' AND jsonb_array_length("rows") <= 500),
  CONSTRAINT "ForemanReportRevision_note_check" CHECK (length("note") <= 500),
  CONSTRAINT "ForemanReportRevision_daySeq_check" CHECK ("daySeq" >= 1)
);
CREATE UNIQUE INDEX "ForemanReportRevision_orgId_reportId_n_key" ON "ForemanReportRevision"("orgId", "reportId", "n");
CREATE TRIGGER foreman_report_revision_append_only BEFORE UPDATE OR DELETE ON "ForemanReportRevision"
  FOR EACH ROW EXECUTE FUNCTION deny_change();

-- ---------- adoption ----------
-- The PM's explicit decision to take a COMPLETE foreman total as the day's quantity. The item
-- must be a work item of the same project (composite FK); the basis is the exact roster
-- version, expected crews and revision numbers the decision was made on.
CREATE TABLE "ForemanAdoption" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "businessDate" DATE NOT NULL,
  "itemKind" TEXT NOT NULL DEFAULT 'work',
  "itemKey" TEXT NOT NULL,
  "value" DECIMAL(20,6) NOT NULL,
  "basis" JSONB NOT NULL,
  "daySeq" BIGINT NOT NULL,
  "byAccountId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "ForemanAdoption_orgId_projectId_itemKind_itemKey_fkey" FOREIGN KEY ("orgId", "projectId", "itemKind", "itemKey") REFERENCES "ReportItem"("orgId", "projectId", "kind", "key") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ForemanAdoption_orgId_byAccountId_fkey" FOREIGN KEY ("orgId", "byAccountId") REFERENCES "LoginAccount"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ForemanAdoption_itemKind_check" CHECK ("itemKind" = 'work'),
  CONSTRAINT "ForemanAdoption_value_check" CHECK ("value" >= 0),
  CONSTRAINT "ForemanAdoption_basis_check" CHECK (jsonb_typeof("basis") = 'object'),
  CONSTRAINT "ForemanAdoption_daySeq_check" CHECK ("daySeq" >= 1)
);
CREATE INDEX "ForemanAdoption_day_idx" ON "ForemanAdoption"("orgId", "projectId", "businessDate");
CREATE TRIGGER foreman_adoption_append_only BEFORE UPDATE OR DELETE ON "ForemanAdoption"
  FOR EACH ROW EXECUTE FUNCTION deny_change();

-- ---------- grants and row-level security ----------
GRANT SELECT, INSERT ON "ForemanReport", "ForemanReportRevision", "ForemanAdoption" TO mje_alpha_app;
GRANT UPDATE ("currentN") ON "ForemanReport" TO mje_alpha_app;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['ForemanReport', 'ForemanReportRevision', 'ForemanAdoption'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY alpha_org ON %I TO mje_alpha_app USING ("orgId"::text = current_setting(''app.org_id'', true)) WITH CHECK ("orgId"::text = current_setting(''app.org_id'', true))', table_name);
  END LOOP;
END $$;
