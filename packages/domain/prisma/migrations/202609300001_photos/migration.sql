-- U2.1 photos (rule 8; additive). A site-report photo reuses the Phase 0 "PhotoEvidence" table:
-- one row per distinct file per org (content-addressed by sha256), owned by one project and one
-- site business day. A photo supports a specific moment and view only; nothing here verifies it.
-- In-app capture ("camera") must carry the device fix; an album upload never carries the
-- uploader's position, only what the file itself claims (EXIF time and GPS).
-- Links to a work item or an issue reuse "EvidenceLink" and are append-only: a change inserts a
-- new row and marks the previous one superseded (once, nothing else may change), so the full
-- link history stays and a submitted report keeps the link it froze.
-- Rows without "businessDate" are the older Phase 0 kinds and keep their previous rules.
-- Blob keys are content-addressed (photo: orgId/sha256, thumbnail: orgId/thumbSha256.thumb), so
-- an object left by a rolled-back upload can only ever hold the bytes its key names.

ALTER TABLE "PhotoEvidence"
  ADD COLUMN "projectId" UUID,
  ADD COLUMN "businessDate" DATE,
  ADD COLUMN "source" TEXT,
  -- Device fix of an in-app capture (declared by the device).
  ADD COLUMN "captureLat" NUMERIC(9, 6),
  ADD COLUMN "captureLon" NUMERIC(9, 6),
  ADD COLUMN "captureAccuracyM" NUMERIC(8, 2),
  ADD COLUMN "captureFixAt" TIMESTAMPTZ(6),
  -- Read from the file on the server (EXIF). "fileTakenLocal" is DateTimeOriginal as written
  -- (no zone); "fileTakenAt" is set only when the file also records its UTC offset.
  ADD COLUMN "fileTakenAt" TIMESTAMPTZ(6),
  ADD COLUMN "fileTakenLocal" TEXT,
  ADD COLUMN "fileGpsLat" NUMERIC(9, 6),
  ADD COLUMN "fileGpsLon" NUMERIC(9, 6),
  -- Client-made thumbnail, content-addressed by its own digest.
  ADD COLUMN "thumbBlobKey" TEXT,
  ADD COLUMN "thumbMediaType" TEXT,
  ADD COLUMN "thumbSha256" CHAR(64),
  ADD COLUMN "uploadedByAccountId" UUID,
  ADD COLUMN "uploadedByPersonId" UUID,
  -- Upload order; never the clock.
  ADD COLUMN "seq" BIGINT GENERATED ALWAYS AS IDENTITY,
  ADD CONSTRAINT "PhotoEvidence_project_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "PhotoEvidence_uploadedByAccount_fkey" FOREIGN KEY ("orgId", "uploadedByAccountId") REFERENCES "LoginAccount"("orgId", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "PhotoEvidence_uploadedByPerson_fkey" FOREIGN KEY ("orgId", "uploadedByPersonId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT,
  -- A report photo has its project, day, source and uploader; the older kinds have none of them.
  ADD CONSTRAINT "PhotoEvidence_report_check" CHECK (
    ("businessDate" IS NULL AND "projectId" IS NULL AND "source" IS NULL AND "uploadedByAccountId" IS NULL AND "uploadedByPersonId" IS NULL)
    OR ("businessDate" IS NOT NULL AND "projectId" IS NOT NULL AND "source" IS NOT NULL AND "uploadedByAccountId" IS NOT NULL AND "uploadedByPersonId" IS NOT NULL
      AND "mediaType" IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif')
      AND "sizeBytes" BETWEEN 1 AND 10485760
      AND "blobKey" = "orgId"::text || '/' || "sha256")),
  ADD CONSTRAINT "PhotoEvidence_source_check" CHECK ("source" IN ('camera', 'album')),
  ADD CONSTRAINT "PhotoEvidence_sha256_check" CHECK ("businessDate" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$'),
  -- Rule 8: an in-app capture has a complete device fix; an album upload records no uploader position.
  ADD CONSTRAINT "PhotoEvidence_camera_fix_check" CHECK ("source" IS DISTINCT FROM 'camera'
    OR ("captureLat" IS NOT NULL AND "captureLon" IS NOT NULL AND "captureAccuracyM" IS NOT NULL AND "captureFixAt" IS NOT NULL)),
  ADD CONSTRAINT "PhotoEvidence_album_no_fix_check" CHECK ("source" IS DISTINCT FROM 'album'
    OR ("captureLat" IS NULL AND "captureLon" IS NULL AND "captureAccuracyM" IS NULL AND "captureFixAt" IS NULL AND "deviceCapturedAt" IS NULL)),
  -- The file's GPS is only recorded for album uploads (rule 8: capture never relies on it).
  ADD CONSTRAINT "PhotoEvidence_file_gps_check" CHECK (("fileGpsLat" IS NULL) = ("fileGpsLon" IS NULL)
    AND ("fileGpsLat" IS NULL OR "source" = 'album')),
  ADD CONSTRAINT "PhotoEvidence_coordinates_check" CHECK (
    ("captureLat" IS NULL OR "captureLat" BETWEEN -90 AND 90) AND ("captureLon" IS NULL OR "captureLon" BETWEEN -180 AND 180)
    AND ("fileGpsLat" IS NULL OR "fileGpsLat" BETWEEN -90 AND 90) AND ("fileGpsLon" IS NULL OR "fileGpsLon" BETWEEN -180 AND 180)
    AND ("captureAccuracyM" IS NULL OR "captureAccuracyM" >= 0)),
  ADD CONSTRAINT "PhotoEvidence_file_taken_check" CHECK ("fileTakenLocal" IS NULL OR "fileTakenLocal" ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$'),
  ADD CONSTRAINT "PhotoEvidence_file_taken_at_check" CHECK ("fileTakenAt" IS NULL OR "fileTakenLocal" IS NOT NULL),
  ADD CONSTRAINT "PhotoEvidence_thumb_check" CHECK (("thumbBlobKey" IS NULL) = ("thumbMediaType" IS NULL)
    AND ("thumbBlobKey" IS NULL) = ("thumbSha256" IS NULL)
    AND ("thumbBlobKey" IS NULL OR ("thumbSha256" ~ '^[0-9a-f]{64}$'
      AND "thumbBlobKey" = "orgId"::text || '/' || "thumbSha256" || '.thumb'
      AND "thumbMediaType" IN ('image/jpeg', 'image/png', 'image/webp'))));
CREATE INDEX "PhotoEvidence_project_day_idx" ON "PhotoEvidence"("orgId", "projectId", "businessDate", "seq");

ALTER TABLE "EvidenceLink"
  ADD COLUMN "businessDate" DATE,
  ADD COLUMN "workItemKey" TEXT,
  ADD COLUMN "issueId" UUID,
  ADD COLUMN "supersededAt" TIMESTAMPTZ(6),
  ADD COLUMN "supersededBy" UUID,
  -- Link order per photo; never the clock.
  ADD COLUMN "seq" BIGINT GENERATED ALWAYS AS IDENTITY,
  ADD CONSTRAINT "EvidenceLink_issue_fkey" FOREIGN KEY ("orgId", "issueId") REFERENCES "Issue"("orgId", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "EvidenceLink_supersededBy_fkey" FOREIGN KEY ("orgId", "supersededBy") REFERENCES "LoginAccount"("orgId", "id") ON DELETE RESTRICT,
  -- A report link (businessDate set) backs exactly one work item or one issue and nothing else;
  -- the older link kinds never use the report columns.
  ADD CONSTRAINT "EvidenceLink_report_target_check" CHECK (
    ("businessDate" IS NULL AND "workItemKey" IS NULL AND "issueId" IS NULL AND "supersededAt" IS NULL)
    OR ("businessDate" IS NOT NULL AND (("workItemKey" IS NULL) <> ("issueId" IS NULL))
      AND "taskId" IS NULL AND "verificationId" IS NULL AND "inspectionId" IS NULL)),
  ADD CONSTRAINT "EvidenceLink_workItemKey_check" CHECK ("workItemKey" ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
  ADD CONSTRAINT "EvidenceLink_superseded_pair_check" CHECK (("supersededAt" IS NULL) = ("supersededBy" IS NULL));
-- At most one current report link per photo.
CREATE UNIQUE INDEX "EvidenceLink_photo_current_key" ON "EvidenceLink"("orgId", "photoId")
  WHERE "businessDate" IS NOT NULL AND "supersededAt" IS NULL;
CREATE INDEX "EvidenceLink_photo_idx" ON "EvidenceLink"("orgId", "photoId", "seq");

-- Report links are append-only: never deleted; the only change is superseding a current link once.
CREATE FUNCTION evidence_link_supersede_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."businessDate" IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'report photo links are append-only'; END IF;
  IF OLD."supersededAt" IS NOT NULL OR NEW."supersededAt" IS NULL
    OR (to_jsonb(NEW) - 'supersededAt' - 'supersededBy') IS DISTINCT FROM (to_jsonb(OLD) - 'supersededAt' - 'supersededBy') THEN
    RAISE EXCEPTION 'a report photo link can only be superseded, once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evidence_link_append_only BEFORE UPDATE OR DELETE ON "EvidenceLink"
  FOR EACH ROW EXECUTE FUNCTION evidence_link_supersede_only();

-- Neither table had grants or RLS for the application role before this migration. Photos are
-- insert-only for the application; a link can only be marked superseded (two columns).
GRANT SELECT, INSERT ON "PhotoEvidence", "EvidenceLink" TO mje_alpha_app;
GRANT UPDATE ("supersededAt", "supersededBy") ON "EvidenceLink" TO mje_alpha_app;
-- Photos link to issues and work items of their project; issues and report items were readable already.
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['PhotoEvidence', 'EvidenceLink'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY alpha_org ON %I TO mje_alpha_app USING ("orgId"::text = current_setting(''app.org_id'', true)) WITH CHECK ("orgId"::text = current_setting(''app.org_id'', true))', table_name);
  END LOOP;
END $$;
