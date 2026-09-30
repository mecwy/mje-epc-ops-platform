-- A6a-2 clock regression (design §5 "Clock and freshness"; additive). A per-project high-water
-- mark of database time already observed in the project. Deadline decisions refuse (503 RETRY)
-- while the clock is behind it, so a clock that steps back can neither revive an elapsed
-- deadline nor let a roster change move an elapsed membership end. NULL = nothing observed yet.
ALTER TABLE "ProjectRoster" ADD COLUMN "clockHighWater" TIMESTAMPTZ(6);
GRANT UPDATE ("clockHighWater") ON "ProjectRoster" TO mje_alpha_app;

CREATE FUNCTION project_clock_forward_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."clockHighWater" IS DISTINCT FROM OLD."clockHighWater"
    AND (NEW."clockHighWater" IS NULL OR NEW."clockHighWater" < OLD."clockHighWater") THEN
    RAISE EXCEPTION 'the clock high-water mark never moves back';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_clock_forward_only BEFORE UPDATE ON "ProjectRoster"
  FOR EACH ROW EXECUTE FUNCTION project_clock_forward_only();
