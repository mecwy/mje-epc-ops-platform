-- C04: append-only manager judgment of an exact original declaration revision.
-- Existing declarations remain the only completion quantity source.
CREATE UNIQUE INDEX foreman_report_review_scope ON "ForemanReport"("orgId","projectId","businessDate","crewId",id);
CREATE UNIQUE INDEX foreman_revision_review_scope ON "ForemanReportRevision"("orgId","projectId","reportId",id);
CREATE TABLE "ManagerReviewEvent" (
 id uuid PRIMARY KEY, "orgId" uuid NOT NULL REFERENCES "Organization"(id) ON UPDATE NO ACTION ON DELETE RESTRICT, "projectId" uuid NOT NULL,
 "crewId" uuid NOT NULL, "foremanReportId" uuid NOT NULL, "foremanRevisionId" uuid NOT NULL,
 "itemKey" text NOT NULL, "businessDate" date NOT NULL, "siteTimezone" text NOT NULL,
 version integer NOT NULL CHECK(version BETWEEN 1 AND 1000000),
 decision text NOT NULL CHECK(decision IN ('CONFIRM_SCOPE','RETURN','INCONCLUSIVE')),
 "coverageKind" text CHECK("coverageKind" IN ('WHOLE','PARTIAL')), "confirmedQty" numeric(20,6), unit text, "scopeRef" uuid,
 "evidenceBasis" jsonb, reason text NOT NULL, method text NOT NULL, limitations text NOT NULL,
 "authorityGrantId" uuid NOT NULL, "authorityPolicyRef" uuid NOT NULL, "independencePolicyRef" uuid NOT NULL,
 "actorAccountId" uuid NOT NULL, "actorPersonId" uuid NOT NULL, "clientMutationId" uuid NOT NULL,
 "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(), "daySeq" bigint NOT NULL CHECK("daySeq">0),
 CONSTRAINT review_event_scope_fk FOREIGN KEY("orgId","projectId","businessDate","crewId","foremanReportId")
   REFERENCES "ForemanReport"("orgId","projectId","businessDate","crewId",id) ON UPDATE NO ACTION ON DELETE RESTRICT,
 CONSTRAINT review_event_revision_fk FOREIGN KEY("orgId","projectId","foremanReportId","foremanRevisionId")
   REFERENCES "ForemanReportRevision"("orgId","projectId","reportId",id) ON UPDATE NO ACTION ON DELETE RESTRICT,
 FOREIGN KEY("orgId","projectId") REFERENCES "Project"("orgId",id) ON UPDATE NO ACTION ON DELETE RESTRICT,
 FOREIGN KEY("orgId","projectId","crewId") REFERENCES "Crew"("orgId","projectId",id) ON UPDATE NO ACTION ON DELETE RESTRICT,
 FOREIGN KEY("orgId","actorAccountId") REFERENCES "LoginAccount"("orgId",id) ON UPDATE NO ACTION ON DELETE RESTRICT,
 FOREIGN KEY("orgId","actorPersonId") REFERENCES "Person"("orgId",id) ON UPDATE NO ACTION ON DELETE RESTRICT,
 CONSTRAINT review_event_sequence UNIQUE("orgId","projectId","foremanRevisionId","itemKey",version),
 CONSTRAINT review_event_mutation UNIQUE("orgId","clientMutationId"),
 CHECK((decision='CONFIRM_SCOPE' AND "coverageKind" IS NOT NULL AND "confirmedQty" IS NOT NULL AND "confirmedQty">=0 AND "scopeRef" IS NOT NULL AND unit IS NOT NULL AND "evidenceBasis" IS NOT NULL AND length(trim(method))>0)
 OR (decision IN ('RETURN','INCONCLUSIVE') AND "coverageKind" IS NULL AND "confirmedQty" IS NULL AND "scopeRef" IS NULL AND unit IS NULL AND length(trim(reason))>0))
);
ALTER TABLE "ManagerReviewEvent" ENABLE ROW LEVEL SECURITY;
CREATE POLICY manager_review_org ON "ManagerReviewEvent" TO mje_alpha_app
 USING ("orgId"::text=current_setting('app.org_id',true)) WITH CHECK ("orgId"::text=current_setting('app.org_id',true));
GRANT SELECT,INSERT ON "ManagerReviewEvent" TO mje_alpha_app;
CREATE TRIGGER manager_review_event_append_only BEFORE UPDATE OR DELETE ON "ManagerReviewEvent" FOR EACH ROW EXECUTE FUNCTION deny_change();
CREATE INDEX manager_review_day_cut ON "ManagerReviewEvent"("orgId","projectId","businessDate","daySeq");
