-- A6a-2 clock regression (design §5 "Clock and freshness"; additive). A per-project high-water
-- mark of database time already observed in the project. Each transaction takes one decision
-- time (clock_timestamp(), once every lock is held); it is refused (503 RETRY) while behind the
-- mark, and only such a decision time, never ahead of the clock, is published as the mark. So a
-- clock that steps back can neither revive an elapsed deadline nor let a roster change move an
-- elapsed membership end. NULL = nothing observed yet.
ALTER TABLE "ProjectRoster" ADD COLUMN "clockHighWater" TIMESTAMPTZ(6);
GRANT UPDATE ("clockHighWater") ON "ProjectRoster" TO mje_alpha_app;

-- Whether the session user is (directly or through other roles) an application login.
-- pg_has_role() cannot be used: it counts a superuser as a member of every role.
CREATE FUNCTION field_is_app_session() RETURNS BOOLEAN LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp AS $$
  WITH RECURSIVE m(oid) AS (
    SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = pg_catalog."session_user"()
    UNION SELECT a.roleid FROM pg_catalog.pg_auth_members a JOIN m ON a.member = m.oid
  )
  SELECT EXISTS (SELECT 1 FROM m JOIN pg_catalog.pg_roles r ON r.oid = m.oid WHERE r.rolname = 'mje_alpha_app')
$$;

-- The mark never moves back; only field_reset_clock_mark() lowers it, to the current clock.
CREATE FUNCTION project_clock_forward_only() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."clockHighWater" IS DISTINCT FROM OLD."clockHighWater"
    AND (NEW."clockHighWater" IS NULL OR NEW."clockHighWater" < OLD."clockHighWater") THEN
    IF pg_catalog.current_setting('app.clock_reset', true) = 'on' AND NOT public.field_is_app_session()
      AND NEW."clockHighWater" IS NOT NULL AND NEW."clockHighWater" <= pg_catalog.clock_timestamp() THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'the clock high-water mark never moves back';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_clock_forward_only BEFORE UPDATE ON "ProjectRoster"
  FOR EACH ROW EXECUTE FUNCTION project_clock_forward_only();

-- The elapsed-membership rule judges by the clock (never a caller-writable setting). Every
-- function and trigger body this migration defines pins search_path to pg_catalog with pg_temp
-- last and qualifies catalog and table names, so a temporary table cannot shadow them (the app
-- role keeps the database's default TEMP privilege, which no migration of ours grants or owns).
CREATE OR REPLACE FUNCTION field_device_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'field devices are never deleted'; END IF;
  IF (pg_catalog.to_jsonb(NEW) - ARRAY['state', 'tokenHash', 'prevTokenHash', 'rotatedAt', 'generation', 'memberUntil', 'lastSeenAt',
      'confirmedAt', 'confirmedByPersonId', 'confirmedByAccountId', 'confirmedByDeviceId', 'endedAt', 'endReason', 'version'])
    IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY['state', 'tokenHash', 'prevTokenHash', 'rotatedAt', 'generation', 'memberUntil', 'lastSeenAt',
      'confirmedAt', 'confirmedByPersonId', 'confirmedByAccountId', 'confirmedByDeviceId', 'endedAt', 'endReason', 'version']) THEN
    RAISE EXCEPTION 'a field device keeps its identity and deadlines';
  END IF;
  IF OLD."state" IN ('REJECTED', 'REVOKED', 'EXPIRED') THEN
    IF (pg_catalog.to_jsonb(NEW) - 'prevTokenHash') IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'prevTokenHash')
      OR NEW."prevTokenHash" IS DISTINCT FROM OLD."prevTokenHash" AND NEW."prevTokenHash" IS NOT NULL THEN
      RAISE EXCEPTION 'an ended field device never changes';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."state" <> OLD."state" AND NOT ((OLD."state" = 'PENDING' AND NEW."state" IN ('CONFIRMED', 'REJECTED', 'EXPIRED'))
    OR (OLD."state" = 'CONFIRMED' AND NEW."state" IN ('REVOKED', 'EXPIRED'))) THEN
    RAISE EXCEPTION 'field device states only move forward';
  END IF;
  IF NEW."memberUntil" IS DISTINCT FROM OLD."memberUntil" AND OLD."memberUntil" IS NOT NULL
    AND OLD."memberUntil" <= pg_catalog.clock_timestamp() THEN
    -- Judged by the clock itself, never a caller-writable setting; the clock is at or after the
    -- transaction's decision time, so this is stricter than the store (SQLSTATE MJE01 -> RETRY).
    RAISE EXCEPTION 'an elapsed membership end never moves' USING ERRCODE = 'MJE01';
  END IF;
  IF NEW."tokenHash" <> OLD."tokenHash" AND (NEW."prevTokenHash" IS DISTINCT FROM OLD."tokenHash" OR NEW."generation" <> OLD."generation" + 1) THEN
    RAISE EXCEPTION 'a token changes only by rotation';
  END IF;
  IF NEW."lastSeenAt" < OLD."lastSeenAt" OR NEW."version" < OLD."version" OR NEW."generation" < OLD."generation" THEN
    RAISE EXCEPTION 'field device counters never move back';
  END IF;
  RETURN NEW;
END $$;

-- Recovery from a mark ahead of true time (for example a forward clock spike), for the
-- migration identity only: every live device of the project whose deadline is at or before the
-- old mark is persisted EXPIRED first, so no expiry the mark stood for is lost; the mark is
-- then lowered to the current clock, and an append-only audit row records the old and new mark,
-- the reason and the actor. The application role cannot execute it.
CREATE FUNCTION field_reset_clock_mark(p_project UUID, p_reason TEXT)
RETURNS TABLE ("oldMark" TIMESTAMPTZ, "newMark" TIMESTAMPTZ, "expiredDevices" INTEGER)
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_org UUID; v_old TIMESTAMPTZ; v_new TIMESTAMPTZ; v_n INTEGER;
BEGIN
  IF public.field_is_app_session() THEN RAISE EXCEPTION 'not for the application role'; END IF;
  IF p_reason IS NULL OR pg_catalog.length(pg_catalog.btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'a reason of at least 10 characters is required';
  END IF;
  SELECT "orgId" INTO v_org FROM public."ProjectRoster" WHERE "projectId" = p_project;
  IF NOT FOUND THEN RAISE EXCEPTION 'no roster for this project'; END IF;
  -- Level 0 exclusive: no roster write runs meanwhile.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_org::text || ':field-roster:' || p_project::text, 0));
  SELECT "clockHighWater" INTO v_old FROM public."ProjectRoster" WHERE "projectId" = p_project FOR UPDATE;
  v_new := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
  IF v_old IS NULL OR v_old <= v_new THEN
    RAISE EXCEPTION 'the mark is not ahead of the clock; nothing to reset';
  END IF;
  WITH ended AS (
    UPDATE public."FieldDevice" d SET state = 'EXPIRED', "endedAt" = v_new, version = d.version + 1,
      "endReason" = CASE
        WHEN d.state = 'PENDING' AND d."pendingUntil" <= v_old THEN 'PENDING_TIMEOUT'
        WHEN d."expiresAt" <= v_old THEN 'LIFETIME'
        WHEN d."memberUntil" <= v_old THEN 'UNASSIGNED'
        ELSE 'IDLE' END
    WHERE d."orgId" = v_org AND d."projectId" = p_project AND d.state IN ('PENDING', 'CONFIRMED')
      AND ((d.state = 'PENDING' AND d."pendingUntil" <= v_old) OR d."expiresAt" <= v_old
        OR d."memberUntil" <= v_old OR (d.state = 'CONFIRMED' AND d."lastSeenAt" + interval '30 days' <= v_old))
    RETURNING d.id, d."personId", d."endReason"
  ), superseded AS (
    UPDATE public."FieldConfirmChallenge" c SET "supersededAt" = v_new FROM ended
    WHERE c."orgId" = v_org AND c."deviceId" = ended.id AND c."usedAt" IS NULL AND c."supersededAt" IS NULL
    RETURNING 1
  ), events AS (
    INSERT INTO public."FieldDeviceEvent"(id, "orgId", "projectId", "deviceId", "personId", kind, "reasonCode")
    SELECT pg_catalog.gen_random_uuid(), v_org, p_project, id, "personId", 'EXPIRE', "endReason" FROM ended
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM events;
  PERFORM pg_catalog.set_config('app.clock_reset', 'on', true);
  UPDATE public."ProjectRoster" SET "clockHighWater" = v_new WHERE "projectId" = p_project;
  PERFORM pg_catalog.set_config('app.clock_reset', '', true);
  INSERT INTO public."AuditLog"(id, "orgId", "updatedAt", "updatedBy", "actorKind", "entityType", "entityId",
    "entityVersion", action, reason, before, after, "correlationId")
  VALUES (pg_catalog.gen_random_uuid(), v_org, pg_catalog.now(), '00000000-0000-0000-0000-000000000000', 'OPERATOR', 'PROJECT_CLOCK',
    p_project, 0, 'FIELD_CLOCK_RESET', p_reason, pg_catalog.jsonb_build_object('clockHighWater', v_old),
    pg_catalog.jsonb_build_object('clockHighWater', v_new, 'expiredDevices', v_n, 'actor', pg_catalog."session_user"()),
    pg_catalog.gen_random_uuid()::text);
  RETURN QUERY SELECT v_old, v_new, v_n;
END $$;
REVOKE ALL ON FUNCTION field_reset_clock_mark(UUID, TEXT) FROM PUBLIC;
