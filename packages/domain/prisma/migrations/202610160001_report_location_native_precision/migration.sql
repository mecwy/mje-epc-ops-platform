BEGIN;

-- Original input strings remain authoritative. This widens only their exact numeric
-- projections: expanded finite native Number readings can have 324 fractional places.
-- No raw text, actor, timestamp, adoption, Revision or audit is rewritten/backfilled.
ALTER TABLE "ReportLocationRecord"
  ALTER COLUMN lat TYPE NUMERIC(340,324),
  ALTER COLUMN lon TYPE NUMERIC(340,324),
  ALTER COLUMN "accuracyM" TYPE NUMERIC(340,324),
  DROP CONSTRAINT "ReportLocationRecord_check",
  DROP CONSTRAINT "ReportLocationRecord_check1",
  DROP CONSTRAINT "ReportLocationRecord_check2";

-- PostgreSQL regex bounded repetitions stop at 255; these adjacent groups allow 1..324.
ALTER TABLE "ReportLocationRecord"
  ADD CONSTRAINT "ReportLocationRecord_rawLat_check"
    CHECK ("rawLat" ~ '^-?[0-9]{1,3}(\.[0-9]{1,255}[0-9]{0,69})?$'
      AND "rawLat"::numeric BETWEEN -90 AND 90 AND "rawLat"::numeric=lat),
  ADD CONSTRAINT "ReportLocationRecord_rawLon_check"
    CHECK ("rawLon" ~ '^-?[0-9]{1,3}(\.[0-9]{1,255}[0-9]{0,69})?$'
      AND "rawLon"::numeric BETWEEN -180 AND 180 AND "rawLon"::numeric=lon),
  ADD CONSTRAINT "ReportLocationRecord_rawAccuracyM_check"
    CHECK ("rawAccuracyM" ~ '^-?[0-9]{1,6}(\.[0-9]{1,255}[0-9]{0,69})?$'
      AND "rawAccuracyM"::numeric>=0 AND "rawAccuracyM"::numeric<1000000
      AND "rawAccuracyM"::numeric="accuracyM");

COMMENT ON COLUMN "ReportLocationRecord".lat IS
  'Exact NUMERIC projection of rawLat; original text is authoritative, never rounded from native input.';
COMMENT ON COLUMN "ReportLocationRecord".lon IS
  'Exact NUMERIC projection of rawLon; original text is authoritative, never rounded from native input.';
COMMENT ON COLUMN "ReportLocationRecord"."accuracyM" IS
  'Exact NUMERIC projection of rawAccuracyM; safe references expose the original text, not padded NUMERIC output.';

-- Existing tenant RLS, composite foreign keys, append-only trigger and grants stay intact.
COMMIT;
