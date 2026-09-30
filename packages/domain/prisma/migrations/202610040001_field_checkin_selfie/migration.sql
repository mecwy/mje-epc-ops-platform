-- A6b worker check-in and staged selfie (additive; design docs/architecture/a6-field-devices-design.md
-- §3, §5, §7). Per-project site reference and field settings (append-only, numbered), the
-- per-day field sequence behind the submission boundary, worker check-ins (append-only; only
-- the void columns are set, once), staged selfies with a forward-only state machine, and the
-- check-in/selfie link. Rejected attempts reuse "FieldDeviceEvent" with a distance bucket and
-- never coordinates. A check-in never writes hours, headcount or report facts.
-- Every function defined here pins search_path and qualifies catalog and table names.

-- ---------- per-project settings ----------
-- The geofence reference; the latest n is current. Coordinates are project master data and are
-- read only by the server and the project manager.
CREATE TABLE "ProjectSiteReference" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "n" INTEGER NOT NULL,
  "lat" NUMERIC(9, 6) NOT NULL,
  "lon" NUMERIC(9, 6) NOT NULL,
  "radiusM" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "createdBy" UUID NOT NULL,
  CONSTRAINT "ProjectSiteReference_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ProjectSiteReference_orgId_createdBy_fkey" FOREIGN KEY ("orgId", "createdBy") REFERENCES "LoginAccount"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ProjectSiteReference_n_check" CHECK ("n" >= 1),
  CONSTRAINT "ProjectSiteReference_coordinates_check" CHECK ("lat" BETWEEN -90 AND 90 AND "lon" BETWEEN -180 AND 180),
  CONSTRAINT "ProjectSiteReference_radius_check" CHECK ("radiusM" BETWEEN 50 AND 2000)
);
CREATE UNIQUE INDEX "ProjectSiteReference_orgId_projectId_n_key" ON "ProjectSiteReference"("orgId", "projectId", "n");
CREATE TRIGGER project_site_reference_append_only BEFORE UPDATE OR DELETE ON "ProjectSiteReference"
  FOR EACH ROW EXECUTE FUNCTION deny_change();

-- Selfie switch (U1: off by default = no row) and the PM proxy window (default 7 days).
CREATE TABLE "ProjectFieldSetting" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "n" INTEGER NOT NULL,
  "selfieEnabled" BOOLEAN NOT NULL,
  "pmProxyDays" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "createdBy" UUID NOT NULL,
  CONSTRAINT "ProjectFieldSetting_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ProjectFieldSetting_orgId_createdBy_fkey" FOREIGN KEY ("orgId", "createdBy") REFERENCES "LoginAccount"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ProjectFieldSetting_n_check" CHECK ("n" >= 1),
  CONSTRAINT "ProjectFieldSetting_pmProxyDays_check" CHECK ("pmProxyDays" BETWEEN 1 AND 30)
);
CREATE UNIQUE INDEX "ProjectFieldSetting_orgId_projectId_n_key" ON "ProjectFieldSetting"("orgId", "projectId", "n");
CREATE TRIGGER project_field_setting_append_only BEFORE UPDATE OR DELETE ON "ProjectFieldSetting"
  FOR EACH ROW EXECUTE FUNCTION deny_change();

-- ---------- submission boundary ----------
-- Every field write for a day takes the next number under the report day lock; submit freezes
-- the rows numbered at or below the value it reads under the same lock (never receipt time).
CREATE TABLE "FieldDay" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "businessDate" DATE NOT NULL,
  "lastSeq" BIGINT NOT NULL,
  CONSTRAINT "FieldDay_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FieldDay_lastSeq_check" CHECK ("lastSeq" >= 1)
);
CREATE UNIQUE INDEX "FieldDay_orgId_projectId_businessDate_key" ON "FieldDay"("orgId", "projectId", "businessDate");
CREATE FUNCTION field_day_forward_only() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'field days are never deleted'; END IF;
  IF (pg_catalog.to_jsonb(NEW) - 'lastSeq') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'lastSeq')
    OR NEW."lastSeq" <= OLD."lastSeq" THEN
    RAISE EXCEPTION 'a field day sequence only moves forward';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER field_day_forward_only BEFORE UPDATE OR DELETE ON "FieldDay"
  FOR EACH ROW EXECUTE FUNCTION field_day_forward_only();

-- ---------- check-ins ----------
CREATE TABLE "WorkerCheckIn" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "personId" UUID NOT NULL,
  -- Derived from occurredAt in siteTimezone (tz database), never from the receipt date.
  "businessDate" DATE NOT NULL,
  "siteTimezone" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "crewId" UUID,
  "crewAttribution" TEXT NOT NULL,
  -- The acting device (self: the worker's own; foreman proxy: the foreman's); PM: none.
  "deviceId" UUID,
  "actorPersonId" UUID NOT NULL,
  "actorAccountId" UUID,
  -- Occurred (device tap; null = DAY precision, never invented), fix, device-sent, received
  -- (the decision time) and recorded (the insert) times are kept apart.
  "occurredAt" TIMESTAMPTZ(6),
  "timePrecision" TEXT NOT NULL,
  "fixAt" TIMESTAMPTZ(6),
  "deviceSentAt" TIMESTAMPTZ(6),
  "receivedAt" TIMESTAMPTZ(6) NOT NULL,
  "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "clockSkewMs" INTEGER,
  -- The worker's own fix: self check-in only.
  "lat" NUMERIC(9, 6),
  "lon" NUMERIC(9, 6),
  "accuracyM" NUMERIC(8, 2),
  "distanceM" INTEGER,
  "siteRefN" INTEGER,
  -- The acting foreman's or PM's fix: never the worker's location.
  "actorLat" NUMERIC(9, 6),
  "actorLon" NUMERIC(9, 6),
  "actorAccuracyM" NUMERIC(8, 2),
  "actorFixAt" TIMESTAMPTZ(6),
  "actorDistanceM" INTEGER,
  "source" TEXT,
  "reason" TEXT,
  "flags" TEXT[] NOT NULL DEFAULT '{}',
  "daySeq" BIGINT NOT NULL,
  "voidedAt" TIMESTAMPTZ(6),
  "voidedBy" UUID,
  "voidReason" TEXT,
  "voidSeq" BIGINT,
  CONSTRAINT "WorkerCheckIn_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "WorkerCheckIn_orgId_personId_fkey" FOREIGN KEY ("orgId", "personId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "WorkerCheckIn_orgId_projectId_crewId_fkey" FOREIGN KEY ("orgId", "projectId", "crewId") REFERENCES "Crew"("orgId", "projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "WorkerCheckIn_orgId_projectId_deviceId_fkey" FOREIGN KEY ("orgId", "projectId", "deviceId") REFERENCES "FieldDevice"("orgId", "projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "WorkerCheckIn_orgId_actorPersonId_fkey" FOREIGN KEY ("orgId", "actorPersonId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "WorkerCheckIn_orgId_actorAccountId_fkey" FOREIGN KEY ("orgId", "actorAccountId") REFERENCES "LoginAccount"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "WorkerCheckIn_orgId_voidedBy_fkey" FOREIGN KEY ("orgId", "voidedBy") REFERENCES "LoginAccount"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "WorkerCheckIn_orgId_projectId_siteRefN_fkey" FOREIGN KEY ("orgId", "projectId", "siteRefN") REFERENCES "ProjectSiteReference"("orgId", "projectId", "n") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "WorkerCheckIn_kind_check" CHECK ("kind" IN ('SELF', 'FOREMAN_PROXY', 'PM_PROXY')),
  CONSTRAINT "WorkerCheckIn_actor_check" CHECK (CASE "kind"
    WHEN 'SELF' THEN "deviceId" IS NOT NULL AND "actorAccountId" IS NULL AND "actorPersonId" = "personId"
    WHEN 'FOREMAN_PROXY' THEN "deviceId" IS NOT NULL AND "actorAccountId" IS NULL AND "actorPersonId" <> "personId"
    ELSE "deviceId" IS NULL AND "actorAccountId" IS NOT NULL END),
  CONSTRAINT "WorkerCheckIn_precision_check" CHECK ("timePrecision" IN ('EXACT', 'DAY')
    AND ("timePrecision" = 'EXACT') = ("occurredAt" IS NOT NULL)
    AND ("kind" = 'PM_PROXY' OR "timePrecision" = 'EXACT')),
  CONSTRAINT "WorkerCheckIn_device_times_check" CHECK (("kind" = 'PM_PROXY') = ("deviceSentAt" IS NULL)
    AND ("kind" = 'PM_PROXY') = ("fixAt" IS NULL) AND ("kind" = 'PM_PROXY') = ("clockSkewMs" IS NULL)),
  CONSTRAINT "WorkerCheckIn_crew_check" CHECK ("crewAttribution" IN ('OCCURRED_AT', 'ONLY_CREW_OF_DAY', 'UNKNOWN')
    AND ("crewAttribution" = 'UNKNOWN') = ("crewId" IS NULL)),
  -- The worker's location exists only for a self check-in, complete; proxies store the actor's.
  CONSTRAINT "WorkerCheckIn_worker_fix_check" CHECK (CASE WHEN "kind" = 'SELF'
    THEN "lat" IS NOT NULL AND "lon" IS NOT NULL AND "accuracyM" IS NOT NULL AND "distanceM" IS NOT NULL AND "siteRefN" IS NOT NULL
    ELSE "lat" IS NULL AND "lon" IS NULL AND "accuracyM" IS NULL AND "distanceM" IS NULL END),
  CONSTRAINT "WorkerCheckIn_actor_fix_check" CHECK ((("actorLat" IS NULL) = ("actorLon" IS NULL))
    AND (("actorLat" IS NULL) = ("actorAccuracyM" IS NULL)) AND (("actorLat" IS NULL) = ("actorFixAt" IS NULL))
    AND ("kind" <> 'SELF' OR "actorLat" IS NULL) AND ("kind" <> 'FOREMAN_PROXY' OR ("actorLat" IS NOT NULL AND "siteRefN" IS NOT NULL))),
  CONSTRAINT "WorkerCheckIn_coordinates_check" CHECK (("lat" IS NULL OR "lat" BETWEEN -90 AND 90) AND ("lon" IS NULL OR "lon" BETWEEN -180 AND 180)
    AND ("actorLat" IS NULL OR "actorLat" BETWEEN -90 AND 90) AND ("actorLon" IS NULL OR "actorLon" BETWEEN -180 AND 180)
    AND ("accuracyM" IS NULL OR "accuracyM" >= 0) AND ("actorAccuracyM" IS NULL OR "actorAccuracyM" >= 0)
    AND ("distanceM" IS NULL OR "distanceM" >= 0) AND ("actorDistanceM" IS NULL OR "actorDistanceM" >= 0)),
  CONSTRAINT "WorkerCheckIn_source_check" CHECK (("kind" = 'PM_PROXY') = ("source" IS NOT NULL)
    AND ("source" IS NULL OR "source" IN ('OBSERVED_ON_SITE', 'FOREMAN_REPORTED', 'OTHER'))
    AND ("reason" IS NULL OR length("reason") <= 500)),
  CONSTRAINT "WorkerCheckIn_flags_check" CHECK ("flags" <@ ARRAY['LATE', 'NEAR_EDGE', 'MULTI_PROJECT_DAY', 'REMOTE_PROXY',
    'PROXY_LOCATION_COARSE', 'PROXY_LOCATION_UNAVAILABLE']::text[]),
  CONSTRAINT "WorkerCheckIn_seq_check" CHECK ("daySeq" >= 1 AND ("voidSeq" IS NULL OR "voidSeq" > "daySeq")),
  CONSTRAINT "WorkerCheckIn_void_check" CHECK (("voidedAt" IS NULL) = ("voidedBy" IS NULL)
    AND ("voidedAt" IS NULL) = ("voidSeq" IS NULL)
    AND ("voidedAt" IS NULL) = ("voidReason" IS NULL)
    AND ("voidReason" IS NULL OR length(btrim("voidReason")) BETWEEN 1 AND 500))
);
CREATE UNIQUE INDEX "WorkerCheckIn_orgId_id_key" ON "WorkerCheckIn"("orgId", "id");
CREATE UNIQUE INDEX "WorkerCheckIn_orgId_projectId_id_personId_key" ON "WorkerCheckIn"("orgId", "projectId", "id", "personId");
-- The slot: one non-voided check-in per (project, person, business day).
CREATE UNIQUE INDEX "WorkerCheckIn_slot_key" ON "WorkerCheckIn"("orgId", "projectId", "personId", "businessDate") WHERE "voidedAt" IS NULL;
CREATE INDEX "WorkerCheckIn_day_idx" ON "WorkerCheckIn"("orgId", "projectId", "businessDate");
CREATE INDEX "WorkerCheckIn_person_day_idx" ON "WorkerCheckIn"("orgId", "personId", "businessDate");

-- Append-only: never deleted; the only change is setting the void columns, once.
CREATE FUNCTION worker_check_in_void_once() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'check-ins are append-only'; END IF;
  IF OLD."voidedAt" IS NOT NULL OR NEW."voidedAt" IS NULL
    OR (pg_catalog.to_jsonb(NEW) - ARRAY['voidedAt', 'voidedBy', 'voidReason', 'voidSeq'])
      IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY['voidedAt', 'voidedBy', 'voidReason', 'voidSeq']) THEN
    RAISE EXCEPTION 'a check-in can only be voided, once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER worker_check_in_append_only BEFORE UPDATE OR DELETE ON "WorkerCheckIn"
  FOR EACH ROW EXECUTE FUNCTION worker_check_in_void_once();

-- ---------- staged selfies ----------
-- STAGED -> ATTACHED, STAGED -> DELETING -> DELETED, ATTACHED -> DELETING -> DELETED.
-- The blob key names the row (private prefix), so a key never holds another selfie.
CREATE TABLE "FieldSelfie" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "personId" UUID NOT NULL,
  "deviceId" UUID NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "blobKey" TEXT NOT NULL,
  "mediaType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "state" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "attachedAt" TIMESTAMPTZ(6),
  "claimedAt" TIMESTAMPTZ(6),
  "deletedAt" TIMESTAMPTZ(6),
  CONSTRAINT "FieldSelfie_orgId_personId_fkey" FOREIGN KEY ("orgId", "personId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FieldSelfie_orgId_projectId_deviceId_fkey" FOREIGN KEY ("orgId", "projectId", "deviceId") REFERENCES "FieldDevice"("orgId", "projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FieldSelfie_state_check" CHECK ("state" IN ('STAGED', 'ATTACHED', 'DELETING', 'DELETED')),
  CONSTRAINT "FieldSelfie_times_check" CHECK ("expiresAt" > "createdAt"
    AND ("state" <> 'ATTACHED' OR "attachedAt" IS NOT NULL) AND ("state" <> 'STAGED' OR "attachedAt" IS NULL)
    AND ("claimedAt" IS NULL) = ("state" IN ('STAGED', 'ATTACHED'))
    AND ("deletedAt" IS NULL) = ("state" <> 'DELETED')),
  CONSTRAINT "FieldSelfie_file_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'
    AND "mediaType" IN ('image/jpeg', 'image/png', 'image/webp') AND "sizeBytes" BETWEEN 1 AND 3145728
    AND "blobKey" = 'selfie/' || "orgId"::text || '/' || "id"::text)
);
CREATE UNIQUE INDEX "FieldSelfie_orgId_projectId_id_personId_key" ON "FieldSelfie"("orgId", "projectId", "id", "personId");
CREATE INDEX "FieldSelfie_state_idx" ON "FieldSelfie"("orgId", "state", "expiresAt");

CREATE FUNCTION field_selfie_forward_only() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'selfie rows are never deleted'; END IF;
  IF (pg_catalog.to_jsonb(NEW) - ARRAY['state', 'attachedAt', 'claimedAt', 'deletedAt'])
      IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY['state', 'attachedAt', 'claimedAt', 'deletedAt'])
    OR NOT ((OLD."state" = 'STAGED' AND NEW."state" IN ('ATTACHED', 'DELETING'))
      OR (OLD."state" = 'ATTACHED' AND NEW."state" = 'DELETING')
      OR (OLD."state" = 'DELETING' AND NEW."state" = 'DELETED'))
    OR (OLD."attachedAt" IS NOT NULL AND NEW."attachedAt" IS DISTINCT FROM OLD."attachedAt")
    OR (OLD."claimedAt" IS NOT NULL AND NEW."claimedAt" IS DISTINCT FROM OLD."claimedAt") THEN
    RAISE EXCEPTION 'selfie states only move forward';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER field_selfie_forward_only BEFORE UPDATE OR DELETE ON "FieldSelfie"
  FOR EACH ROW EXECUTE FUNCTION field_selfie_forward_only();

-- One selfie per check-in, one check-in per selfie; same project and same person (composite FKs).
CREATE TABLE "CheckInSelfie" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "personId" UUID NOT NULL,
  "checkInId" UUID NOT NULL,
  "selfieId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "CheckInSelfie_orgId_projectId_checkInId_personId_fkey" FOREIGN KEY ("orgId", "projectId", "checkInId", "personId") REFERENCES "WorkerCheckIn"("orgId", "projectId", "id", "personId") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "CheckInSelfie_orgId_projectId_selfieId_personId_fkey" FOREIGN KEY ("orgId", "projectId", "selfieId", "personId") REFERENCES "FieldSelfie"("orgId", "projectId", "id", "personId") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "CheckInSelfie_checkInId_key" ON "CheckInSelfie"("checkInId");
CREATE UNIQUE INDEX "CheckInSelfie_selfieId_key" ON "CheckInSelfie"("selfieId");
CREATE TRIGGER check_in_selfie_append_only BEFORE UPDATE OR DELETE ON "CheckInSelfie"
  FOR EACH ROW EXECUTE FUNCTION deny_change();

-- ---------- refusal events ----------
-- A refused check-in attempt is recorded with its reason and the distance in 100 m buckets only.
ALTER TABLE "FieldDeviceEvent"
  ADD COLUMN "distanceBucketM" INTEGER,
  ADD CONSTRAINT "FieldDeviceEvent_distanceBucket_check" CHECK ("distanceBucketM" IS NULL OR ("distanceBucketM" >= 0 AND "distanceBucketM" % 100 = 0));
ALTER TABLE "FieldDeviceEvent" DROP CONSTRAINT "FieldDeviceEvent_kind_check";
ALTER TABLE "FieldDeviceEvent" ADD CONSTRAINT "FieldDeviceEvent_kind_check" CHECK ("kind" IN ('BIND', 'CHALLENGE', 'CHALLENGE_FAILED',
  'CHALLENGES_RESET', 'CONFIRM', 'REJECT', 'REVOKE', 'RELEASE', 'ROTATE', 'EXPIRE', 'REPLACE', 'SUPERSEDE', 'UNASSIGN', 'CHECKIN_REFUSED'));

-- ---------- grants and row-level security ----------
GRANT SELECT, INSERT ON "ProjectSiteReference", "ProjectFieldSetting", "FieldDay", "WorkerCheckIn",
  "FieldSelfie", "CheckInSelfie" TO mje_alpha_app;
GRANT UPDATE ("lastSeq") ON "FieldDay" TO mje_alpha_app;
GRANT UPDATE ("voidedAt", "voidedBy", "voidReason", "voidSeq") ON "WorkerCheckIn" TO mje_alpha_app;
GRANT UPDATE ("state", "attachedAt", "claimedAt", "deletedAt") ON "FieldSelfie" TO mje_alpha_app;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['ProjectSiteReference', 'ProjectFieldSetting', 'FieldDay', 'WorkerCheckIn',
    'FieldSelfie', 'CheckInSelfie'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY alpha_org ON %I TO mje_alpha_app USING ("orgId"::text = current_setting(''app.org_id'', true)) WITH CHECK ("orgId"::text = current_setting(''app.org_id'', true))', table_name);
  END LOOP;
END $$;
