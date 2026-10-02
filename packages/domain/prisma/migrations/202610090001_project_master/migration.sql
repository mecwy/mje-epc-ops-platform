-- A7-1b. Additive master/calendar metadata. Never rewrites site facts or historic revisions.
ALTER TABLE "Project" ADD COLUMN "primaryWorkItemKey" TEXT, ADD COLUMN region TEXT, ADD COLUMN "projectType" TEXT;
ALTER TABLE "ReportItem" ADD COLUMN "plannedDate" DATE;
ALTER TABLE "ReportItem" DROP CONSTRAINT "ReportItem_kind_check";
ALTER TABLE "ReportItem" ADD CONSTRAINT "ReportItem_kind_check" CHECK(kind IN ('work','machinery','material','milestone'));
ALTER TABLE "ReportItem" ADD CONSTRAINT "ReportItem_milestone_check" CHECK(kind <> 'milestone' OR (unit='' AND "designQty"=''));
CREATE TABLE "ReportingExpectationVersion" (
  id UUID PRIMARY KEY,"orgId" UUID NOT NULL,"projectId" UUID NOT NULL,
  n INTEGER NOT NULL CHECK(n>0),"fromDate" DATE NOT NULL,"toDate" DATE,workdays INTEGER[] NOT NULL,
  "registeredAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),"registeredBy" UUID NOT NULL,
  UNIQUE("orgId",id),UNIQUE("orgId","projectId",n),
  FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
  FOREIGN KEY("orgId","projectId") REFERENCES "Project"("orgId",id) ON DELETE RESTRICT,
  FOREIGN KEY("orgId","registeredBy") REFERENCES "LoginAccount"("orgId",id) ON DELETE RESTRICT,
  CHECK("toDate" IS NULL OR "toDate">="fromDate"),
  CHECK(cardinality(workdays) BETWEEN 1 AND 7 AND array_ndims(workdays)=1 AND array_position(workdays,NULL) IS NULL AND workdays <@ ARRAY[1,2,3,4,5,6,7]),
  -- A set of ISO weekdays: duplicates are rejected, not silently removed.
  CHECK(cardinality(workdays) = (1=ANY(workdays))::int+(2=ANY(workdays))::int+(3=ANY(workdays))::int+(4=ANY(workdays))::int+(5=ANY(workdays))::int+(6=ANY(workdays))::int+(7=ANY(workdays))::int)
);
CREATE FUNCTION reporting_expectation_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Reporting expectation history is append-only'; END;
$$;
REVOKE ALL ON FUNCTION reporting_expectation_append_only() FROM PUBLIC;
CREATE TRIGGER reporting_expectation_append_only BEFORE UPDATE OR DELETE ON "ReportingExpectationVersion" FOR EACH ROW EXECUTE FUNCTION reporting_expectation_append_only();
ALTER TABLE "ReportingExpectationVersion" ENABLE ROW LEVEL SECURITY;
CREATE POLICY alpha_org ON "ReportingExpectationVersion" TO mje_alpha_app USING("orgId"::text=current_setting('app.org_id',true)) WITH CHECK("orgId"::text=current_setting('app.org_id',true));
GRANT SELECT,INSERT ON "ReportingExpectationVersion" TO mje_alpha_app;
GRANT UPDATE("primaryWorkItemKey",region,"projectType","updatedAt","updatedBy") ON "Project" TO mje_alpha_app;
