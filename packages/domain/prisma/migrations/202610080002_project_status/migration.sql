-- A7-1a. Declarations/replies are append-only; they do not verify site facts or approve work.
CREATE TABLE "ProjectStatusUpdate" (
  id UUID PRIMARY KEY,"orgId" UUID NOT NULL,"projectId" UUID NOT NULL,n INTEGER NOT NULL CHECK(n>0),
  status TEXT NOT NULL CHECK(status IN ('NORMAL','AT_RISK','OFF_TRACK','PAUSED')),
  areas TEXT[] NOT NULL CHECK(areas <@ ARRAY['SCHEDULE','RESOURCE','SAFETY','QUALITY','EXTERNAL']::text[]),
  situation TEXT NOT NULL,recovery TEXT NOT NULL,"expectedRecoveryDate" DATE,"expectedRecoveryUnknown" BOOLEAN NOT NULL,
  "needsSupport" BOOLEAN NOT NULL,"supportNote" TEXT NOT NULL,"declaredAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "siteTimezone" TEXT NOT NULL,"businessDate" DATE NOT NULL,"declaredBy" UUID NOT NULL,"declaredByPersonId" UUID NOT NULL,
  UNIQUE("orgId",id),UNIQUE("orgId","projectId",id),UNIQUE("orgId","projectId",n),
  FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
  FOREIGN KEY("orgId","projectId") REFERENCES "Project"("orgId",id) ON DELETE RESTRICT,
  FOREIGN KEY("orgId","declaredBy") REFERENCES "LoginAccount"("orgId",id) ON DELETE RESTRICT,
  FOREIGN KEY("orgId","declaredByPersonId") REFERENCES "Person"("orgId",id) ON DELETE RESTRICT,
  CHECK(status NOT IN ('AT_RISK','OFF_TRACK','PAUSED') OR ("expectedRecoveryDate" IS NULL)="expectedRecoveryUnknown"),
  CHECK(status NOT IN ('AT_RISK','OFF_TRACK') OR (cardinality(areas)>=1 AND btrim(situation)<>'' AND btrim(recovery)<>'')),
  CHECK(status<>'PAUSED' OR btrim(situation)<>''),
  CHECK(status<>'NORMAL' OR (NOT "needsSupport" AND areas='{}'::text[] AND "expectedRecoveryDate" IS NULL AND NOT "expectedRecoveryUnknown")),
  CHECK("needsSupport" OR "supportNote"='')
);
CREATE TABLE "ProjectStatusNote" (
  id UUID PRIMARY KEY,"orgId" UUID NOT NULL,"projectId" UUID NOT NULL,"statusUpdateId" UUID NOT NULL,
  text TEXT NOT NULL CHECK(btrim(text)<>''),"byAccountId" UUID NOT NULL,"byPersonId" UUID NOT NULL,at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE("orgId",id),
  FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
  FOREIGN KEY("orgId","projectId") REFERENCES "Project"("orgId",id) ON DELETE RESTRICT,
  FOREIGN KEY("orgId","projectId","statusUpdateId") REFERENCES "ProjectStatusUpdate"("orgId","projectId",id) ON DELETE RESTRICT,
  FOREIGN KEY("orgId","byAccountId") REFERENCES "LoginAccount"("orgId",id) ON DELETE RESTRICT,
  FOREIGN KEY("orgId","byPersonId") REFERENCES "Person"("orgId",id) ON DELETE RESTRICT
);
CREATE INDEX "ProjectStatusNote_update_idx" ON "ProjectStatusNote"("orgId","projectId","statusUpdateId",at,id);
CREATE FUNCTION project_status_append_only() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN RAISE EXCEPTION 'project status history is append-only'; END $$;
CREATE TRIGGER project_status_update_append_only BEFORE UPDATE OR DELETE ON "ProjectStatusUpdate" FOR EACH ROW EXECUTE FUNCTION project_status_append_only();
CREATE TRIGGER project_status_note_append_only BEFORE UPDATE OR DELETE ON "ProjectStatusNote" FOR EACH ROW EXECUTE FUNCTION project_status_append_only();
ALTER TABLE "ProjectStatusUpdate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProjectStatusNote" ENABLE ROW LEVEL SECURITY;
CREATE POLICY alpha_org ON "ProjectStatusUpdate" TO mje_alpha_app USING("orgId"::text=current_setting('app.org_id',true)) WITH CHECK("orgId"::text=current_setting('app.org_id',true));
CREATE POLICY alpha_org ON "ProjectStatusNote" TO mje_alpha_app USING("orgId"::text=current_setting('app.org_id',true)) WITH CHECK("orgId"::text=current_setting('app.org_id',true));
GRANT SELECT,INSERT ON "ProjectStatusUpdate","ProjectStatusNote" TO mje_alpha_app;
GRANT UPDATE(version) ON "Project" TO mje_alpha_app;
REVOKE ALL ON FUNCTION project_status_append_only() FROM PUBLIC;
