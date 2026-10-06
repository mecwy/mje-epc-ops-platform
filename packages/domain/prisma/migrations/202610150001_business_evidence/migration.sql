-- C05: exact source-linked completion evidence association; no declared/verified quantity mirror.
-- A7 serial schema lease; preserve all prior migrations. READY is availability only.
CREATE TABLE "BusinessEvidenceSet" (
 id uuid PRIMARY KEY, "orgId" uuid NOT NULL, "projectId" uuid NOT NULL,
 "businessDate" date NOT NULL, "crewId" uuid NOT NULL,
 "foremanReportId" uuid NOT NULL, "foremanRevisionId" uuid NOT NULL, "itemKey" text NOT NULL,
 UNIQUE("orgId","projectId",id),
 CONSTRAINT business_evidence_target_key UNIQUE("orgId","projectId","businessDate","crewId","foremanRevisionId","itemKey"),
 CONSTRAINT business_evidence_set_org_fk FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT business_evidence_set_project_fk FOREIGN KEY("orgId","projectId") REFERENCES "Project"("orgId",id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT business_evidence_set_crew_fk FOREIGN KEY("orgId","projectId","crewId") REFERENCES "Crew"("orgId","projectId",id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT business_evidence_set_report_fk FOREIGN KEY("orgId","projectId","businessDate","crewId","foremanReportId") REFERENCES "ForemanReport"("orgId","projectId","businessDate","crewId",id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT business_evidence_set_revision_fk FOREIGN KEY("orgId","projectId","foremanReportId","foremanRevisionId") REFERENCES "ForemanReportRevision"("orgId","projectId","reportId",id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CHECK(length("itemKey") BETWEEN 1 AND 64)
);
CREATE FUNCTION business_evidence_source_target() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public."ForemanReportRevision" r JOIN public."ForemanReport" f ON f."orgId"=r."orgId" AND f."projectId"=r."projectId" AND f.id=r."reportId"
 WHERE r."orgId"=NEW."orgId" AND r."projectId"=NEW."projectId" AND r.id=NEW."foremanRevisionId" AND f."crewId"=NEW."crewId" AND f."businessDate"=NEW."businessDate"
 AND EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(r.rows) row_value WHERE row_value->>'itemKey'=NEW."itemKey"))
 THEN RAISE EXCEPTION 'C05 source target mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER business_evidence_source_target BEFORE INSERT ON "BusinessEvidenceSet" FOR EACH ROW EXECUTE FUNCTION business_evidence_source_target();
CREATE TRIGGER business_evidence_set_immutable BEFORE UPDATE OR DELETE ON "BusinessEvidenceSet" FOR EACH ROW EXECUTE FUNCTION deny_change();
CREATE TABLE "BusinessEvidenceVersion" (
 id uuid PRIMARY KEY, "orgId" uuid NOT NULL, "projectId" uuid NOT NULL, "setId" uuid NOT NULL,
 version integer NOT NULL CHECK(version BETWEEN 1 AND 1000000),
 "coverageJson" jsonb NOT NULL, "photosJson" jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('MISSING','PARTIAL','READY','UNCONFIRMED_SCOPE')),
 "daySeq" bigint NOT NULL CHECK("daySeq">0), "clientMutationId" uuid NOT NULL,
 "commandJson" jsonb NOT NULL, "actorAccountId" uuid NOT NULL, "actorPersonId" uuid NOT NULL,
 "createdAt" timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
 UNIQUE("orgId",id), UNIQUE("orgId","projectId",id),
 UNIQUE("orgId","setId",version), UNIQUE("orgId","clientMutationId"),
 CONSTRAINT business_evidence_version_org_fk FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT business_evidence_version_project_fk FOREIGN KEY("orgId","projectId") REFERENCES "Project"("orgId",id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT business_evidence_version_set_fk FOREIGN KEY("orgId","projectId","setId") REFERENCES "BusinessEvidenceSet"("orgId","projectId",id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT business_evidence_version_account_fk FOREIGN KEY("orgId","actorAccountId") REFERENCES "LoginAccount"("orgId",id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CONSTRAINT business_evidence_version_person_fk FOREIGN KEY("orgId","actorPersonId") REFERENCES "Person"("orgId",id) ON DELETE RESTRICT ON UPDATE NO ACTION,
 CHECK(jsonb_typeof("coverageJson") IN ('null','object')),
 CHECK(jsonb_typeof("photosJson")='array' AND jsonb_array_length("photosJson")<=1000),
 CHECK(jsonb_typeof("commandJson")='object')
);
CREATE FUNCTION business_evidence_manifest_valid() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE p jsonb;
BEGIN
 IF NEW.version <> COALESCE((SELECT max(version)+1 FROM public."BusinessEvidenceVersion" WHERE "orgId"=NEW."orgId" AND "setId"=NEW."setId"),1)
 THEN RAISE EXCEPTION 'C05 version must append' USING ERRCODE='23514'; END IF;
 IF (SELECT count(*) FROM pg_catalog.jsonb_array_elements(NEW."photosJson")) <> (SELECT count(DISTINCT x->>'linkId') FROM pg_catalog.jsonb_array_elements(NEW."photosJson") x)
 OR (SELECT count(*) FROM pg_catalog.jsonb_array_elements(NEW."photosJson")) <> (SELECT count(DISTINCT (x->>'photoId', x->>'photoVersion')) FROM pg_catalog.jsonb_array_elements(NEW."photosJson") x)
 THEN RAISE EXCEPTION 'C05 duplicate manifest photo' USING ERRCODE='23514'; END IF;
 FOR p IN SELECT * FROM pg_catalog.jsonb_array_elements(NEW."photosJson") LOOP
  IF (p->>'photoVersion')::integer < 1 OR (p->>'photoVersion')::integer > 1000000 OR p->>'linkId' IS NULL
   OR NOT EXISTS(SELECT 1 FROM public."PhotoEvidence" m JOIN public."BusinessEvidenceSet" target ON target."orgId"=m."orgId" AND target."projectId"=m."projectId" AND target.id=NEW."setId" WHERE m."orgId"=NEW."orgId" AND m."projectId"=NEW."projectId" AND m."businessDate"=target."businessDate" AND m.id=(p->>'photoId')::uuid AND m.version=(p->>'photoVersion')::integer)
  THEN RAISE EXCEPTION 'C05 media anchor mismatch' USING ERRCODE='23514'; END IF;
  PERFORM (p->>'linkId')::uuid;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER business_evidence_manifest_valid BEFORE INSERT ON "BusinessEvidenceVersion" FOR EACH ROW EXECUTE FUNCTION business_evidence_manifest_valid();
CREATE TRIGGER business_evidence_version_immutable BEFORE UPDATE OR DELETE ON "BusinessEvidenceVersion" FOR EACH ROW EXECUTE FUNCTION deny_change();
ALTER TABLE "BusinessEvidenceSet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessEvidenceSet" FORCE ROW LEVEL SECURITY;
ALTER TABLE "BusinessEvidenceVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BusinessEvidenceVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY business_evidence_org ON "BusinessEvidenceSet" TO mje_alpha_app
 USING("orgId"::text=current_setting('app.org_id',true)) WITH CHECK("orgId"::text=current_setting('app.org_id',true));
CREATE POLICY business_evidence_org ON "BusinessEvidenceVersion" TO mje_alpha_app
 USING("orgId"::text=current_setting('app.org_id',true)) WITH CHECK("orgId"::text=current_setting('app.org_id',true));
GRANT SELECT,INSERT ON "BusinessEvidenceSet","BusinessEvidenceVersion" TO mje_alpha_app;
-- Existing helper is actor-scoped. This route-specific partial index also protects no-op receipts
-- against cross-account tenant-wide mutation-key reuse; no new receipt table or mirrored fact.
CREATE UNIQUE INDEX "BusinessEvidenceMutationReceipt" ON "IdempotencyRecord"("orgId",route,key) WHERE route='business-evidence';
CREATE INDEX business_evidence_day_idx ON "BusinessEvidenceSet"("orgId","projectId","businessDate");
CREATE INDEX business_evidence_cut_idx ON "BusinessEvidenceVersion"("orgId","setId","daySeq");
