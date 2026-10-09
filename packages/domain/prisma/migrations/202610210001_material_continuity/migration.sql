-- Additive site quantity ledger; admission is not independent verification or financial posting.
CREATE TABLE "MaterialQuantityScope" (
 id uuid PRIMARY KEY, "orgId" uuid NOT NULL REFERENCES "Organization"(id), "projectId" uuid NOT NULL,
 "materialItemId" uuid NOT NULL, "materialKey" text NOT NULL, specification text NOT NULL, unit text NOT NULL,
 "workPackageId" text NOT NULL, "scopeVersion" text NOT NULL, ownership text NOT NULL, custody text NOT NULL, location text NOT NULL,
 "openingDate" date NOT NULL, "openingCutoffAt" timestamptz NOT NULL, "openingQuantity" numeric(20,6), "openingBasis" text NOT NULL,
 version integer NOT NULL DEFAULT 1, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedBy" uuid NOT NULL,
 UNIQUE("orgId",id), UNIQUE("orgId","projectId","materialItemId","workPackageId","scopeVersion"),
 FOREIGN KEY("orgId","projectId") REFERENCES "Project"("orgId",id),
 FOREIGN KEY("orgId","materialItemId") REFERENCES "ReportItem"("orgId",id),
 FOREIGN KEY("orgId","updatedBy") REFERENCES "LoginAccount"("orgId",id),
 CHECK("openingQuantity" IS NULL OR ("openingQuantity">=0 AND length(trim("openingBasis"))>0)), CHECK(version>0)
);
CREATE TABLE "MaterialQuantityMovement" (
 id uuid PRIMARY KEY, "orgId" uuid NOT NULL REFERENCES "Organization"(id), "scopeId" uuid NOT NULL,
 sequence integer NOT NULL CHECK(sequence>0), kind text NOT NULL CHECK(kind IN ('opening','use','reversal')), quantity numeric(20,6) NOT NULL,
 "businessDate" date NOT NULL, "sourceRevisionId" uuid, "useFactId" uuid, "reversesId" uuid,
 "basis" text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "actorAccountId" uuid NOT NULL, "actorPersonId" uuid NOT NULL,
 UNIQUE("orgId",id), UNIQUE("orgId","reversesId"),
 FOREIGN KEY("orgId","scopeId") REFERENCES "MaterialQuantityScope"("orgId",id),
 FOREIGN KEY("orgId","sourceRevisionId") REFERENCES "Revision"("orgId",id),
 FOREIGN KEY("orgId","reversesId") REFERENCES "MaterialQuantityMovement"("orgId",id),
 FOREIGN KEY("orgId","actorAccountId") REFERENCES "LoginAccount"("orgId",id),
 FOREIGN KEY("orgId","actorPersonId") REFERENCES "Person"("orgId",id),
 CHECK((kind='opening' AND quantity>=0 AND "useFactId" IS NULL AND "sourceRevisionId" IS NULL AND "reversesId" IS NULL)
 OR (kind='use' AND quantity<=0 AND "useFactId" IS NOT NULL AND "sourceRevisionId" IS NOT NULL AND "reversesId" IS NULL)
 OR (kind='reversal' AND quantity>=0 AND "useFactId" IS NOT NULL AND "sourceRevisionId" IS NOT NULL AND "reversesId" IS NOT NULL))
);
CREATE TABLE "MaterialUseAdmission" (
 id uuid PRIMARY KEY, "orgId" uuid NOT NULL REFERENCES "Organization"(id), "scopeId" uuid NOT NULL,
 "useFactId" uuid NOT NULL, "sourceBusinessDate" date NOT NULL, "sourceRevisionId" uuid NOT NULL,
 "movementId" uuid NOT NULL, "issueId" uuid, "dueAt" timestamptz, "updatedBy" uuid NOT NULL,
 "updatedAt" timestamptz NOT NULL DEFAULT now(), version integer NOT NULL DEFAULT 1,
 UNIQUE("orgId",id), UNIQUE("orgId","useFactId"),
 FOREIGN KEY("orgId","scopeId") REFERENCES "MaterialQuantityScope"("orgId",id),
 FOREIGN KEY("orgId","sourceRevisionId") REFERENCES "Revision"("orgId",id),
 FOREIGN KEY("orgId","movementId") REFERENCES "MaterialQuantityMovement"("orgId",id),
 FOREIGN KEY("orgId","issueId") REFERENCES "Issue"("orgId",id),
 FOREIGN KEY("orgId","updatedBy") REFERENCES "LoginAccount"("orgId",id), CHECK(version>0)
);
CREATE INDEX "MaterialQuantityMovement_scope_date" ON "MaterialQuantityMovement"("orgId","scopeId","businessDate");
CREATE UNIQUE INDEX "MaterialQuantityScope_single_opening" ON "MaterialQuantityMovement"("orgId","scopeId") WHERE kind='opening';
GRANT SELECT,INSERT ON "MaterialQuantityMovement" TO mje_alpha_app;
GRANT SELECT,INSERT,UPDATE ON "MaterialQuantityScope","MaterialUseAdmission" TO mje_alpha_app;
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['MaterialQuantityScope','MaterialQuantityMovement','MaterialUseAdmission'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY alpha_org ON %I TO mje_alpha_app USING ("orgId"::text = current_setting(''app.org_id'',true)) WITH CHECK ("orgId"::text = current_setting(''app.org_id'',true))',t);
END LOOP; END $$;
CREATE FUNCTION material_movement_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$ BEGIN RAISE EXCEPTION 'Material quantity movements are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER material_movement_immutable BEFORE UPDATE OR DELETE ON "MaterialQuantityMovement" FOR EACH ROW EXECUTE FUNCTION material_movement_immutable();
