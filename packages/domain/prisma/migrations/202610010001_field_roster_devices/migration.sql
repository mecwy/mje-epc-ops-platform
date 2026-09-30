-- A6a field roster, devices and entry (additive; design: docs/architecture/a6-field-devices-design.md).
-- Crews and append-only crew assignment intervals with a per-project roster version; field
-- devices (a browser-held secret for one Person on one project, confirmed face to face by a PM
-- or the crew foreman) with their token-hash registry, confirmation challenges and lifecycle
-- events; the rotatable project entry code; pre-authentication throttle counters.
-- No coordinates, names, tokens or codes are written to any event row. Existing tables are
-- untouched apart from read access to "Person" (display names) for the application role.

-- ---------- display names (read-only, org-scoped) ----------
GRANT SELECT ON "Person" TO mje_alpha_app;
ALTER TABLE "Person" ENABLE ROW LEVEL SECURITY;
CREATE POLICY alpha_org ON "Person" TO mje_alpha_app
  USING ("orgId"::text = current_setting('app.org_id', true))
  WITH CHECK ("orgId"::text = current_setting('app.org_id', true));

-- ---------- roster ----------
CREATE TABLE "Crew" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "activeFrom" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "activeUntil" TIMESTAMPTZ(6),
  "createdBy" UUID NOT NULL,
  CONSTRAINT "Crew_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Crew_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "Crew_orgId_createdBy_fkey" FOREIGN KEY ("orgId", "createdBy") REFERENCES "LoginAccount"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "Crew_code_check" CHECK ("code" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$'),
  CONSTRAINT "Crew_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 80),
  CONSTRAINT "Crew_active_check" CHECK ("activeUntil" IS NULL OR "activeUntil" >= "activeFrom")
);
CREATE UNIQUE INDEX "Crew_orgId_id_key" ON "Crew"("orgId", "id");
CREATE UNIQUE INDEX "Crew_orgId_projectId_id_key" ON "Crew"("orgId", "projectId", "id");
CREATE UNIQUE INDEX "Crew_orgId_projectId_code_key" ON "Crew"("orgId", "projectId", "code");

-- Every roster write increments the version under the exclusive project roster lock.
CREATE TABLE "ProjectRoster" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "ProjectRoster_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ProjectRoster_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "ProjectRoster_version_check" CHECK ("version" >= 0)
);
CREATE UNIQUE INDEX "ProjectRoster_orgId_projectId_key" ON "ProjectRoster"("orgId", "projectId");

-- Half-open [validFrom, validUntil) intervals. Nothing is backdated: an interval opens at the
-- transaction time or later, and its end is set once, at the transaction time or later, so
-- membership at any past instant is immutable.
CREATE TABLE "CrewAssignment" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "crewId" UUID NOT NULL,
  "personId" UUID NOT NULL,
  "role" TEXT NOT NULL,
  "validFrom" TIMESTAMPTZ(6) NOT NULL,
  "validUntil" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "createdBy" UUID NOT NULL,
  "closedBy" UUID,
  CONSTRAINT "CrewAssignment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CrewAssignment_orgId_projectId_crewId_fkey" FOREIGN KEY ("orgId", "projectId", "crewId") REFERENCES "Crew"("orgId", "projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "CrewAssignment_orgId_personId_fkey" FOREIGN KEY ("orgId", "personId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "CrewAssignment_orgId_createdBy_fkey" FOREIGN KEY ("orgId", "createdBy") REFERENCES "LoginAccount"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "CrewAssignment_orgId_closedBy_fkey" FOREIGN KEY ("orgId", "closedBy") REFERENCES "LoginAccount"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "CrewAssignment_role_check" CHECK ("role" IN ('MEMBER', 'FOREMAN')),
  CONSTRAINT "CrewAssignment_interval_check" CHECK ("validUntil" IS NULL OR "validUntil" >= "validFrom"),
  CONSTRAINT "CrewAssignment_closed_check" CHECK (("validUntil" IS NULL) = ("closedBy" IS NULL))
);
CREATE INDEX "CrewAssignment_person_idx" ON "CrewAssignment"("orgId", "projectId", "personId", "validFrom");
CREATE INDEX "CrewAssignment_crew_idx" ON "CrewAssignment"("orgId", "crewId", "validFrom");

-- Append-only intervals; the only change is closing an open interval once, at now() or later.
-- Non-overlap per (project, person) for MEMBER, per crew and per (project, person) for FOREMAN,
-- checked under the person advisory lock (and the crew lock for FOREMAN) that the application
-- also uses, so concurrent inserts serialize even without the project roster lock.
CREATE FUNCTION crew_assignment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'crew assignments are append-only'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."validFrom" < now() OR NEW."validUntil" IS NOT NULL THEN
      RAISE EXCEPTION 'a crew assignment opens at now() or later, without an end';
    END IF;
  ELSIF OLD."validUntil" IS NOT NULL OR NEW."validUntil" IS NULL OR NEW."validUntil" < now()
    OR (to_jsonb(NEW) - 'validUntil' - 'closedBy') IS DISTINCT FROM (to_jsonb(OLD) - 'validUntil' - 'closedBy') THEN
    RAISE EXCEPTION 'a crew assignment can only be closed, once, at now() or later';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."orgId"::text || ':field-person:' || NEW."projectId"::text || ':' || NEW."personId"::text, 0));
  IF NEW."role" = 'FOREMAN' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW."orgId"::text || ':field-crew:' || NEW."crewId"::text, 0));
  END IF;
  IF EXISTS (SELECT 1 FROM "CrewAssignment" a
    WHERE a."orgId" = NEW."orgId" AND a."projectId" = NEW."projectId" AND a.id <> NEW.id AND a."role" = NEW."role"
      AND (a."personId" = NEW."personId" OR (NEW."role" = 'FOREMAN' AND a."crewId" = NEW."crewId"))
      AND tstzrange(a."validFrom", a."validUntil", '[)') && tstzrange(NEW."validFrom", NEW."validUntil", '[)')) THEN
    RAISE EXCEPTION 'crew assignment intervals overlap' USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crew_assignment_append_only BEFORE INSERT OR UPDATE OR DELETE ON "CrewAssignment"
  FOR EACH ROW EXECUTE FUNCTION crew_assignment_guard();

-- The person's continuous MEMBER run in the project that contains p_at: whether there is one and
-- where it ends (null = open-ended; p_at when there is none). Intervals chain when one starts
-- exactly where the previous ends (a transfer in one transaction). Exact timestamps, in SQL, so
-- a microsecond gap between two transactions is a gap. Runs with the caller's rights (RLS).
CREATE FUNCTION field_member_run(p_org UUID, p_project UUID, p_person UUID, p_at TIMESTAMPTZ)
RETURNS TABLE ("member" BOOLEAN, "until" TIMESTAMPTZ) LANGUAGE sql STABLE AS $$
  WITH RECURSIVE run AS (
    SELECT a."validUntil" AS until, 1 AS depth FROM "CrewAssignment" a
    WHERE a."orgId" = p_org AND a."projectId" = p_project AND a."personId" = p_person AND a."role" = 'MEMBER'
      AND a."validFrom" <= p_at AND (a."validUntil" IS NULL OR p_at < a."validUntil")
    UNION ALL
    SELECT a."validUntil", run.depth + 1 FROM run JOIN "CrewAssignment" a
      ON a."orgId" = p_org AND a."projectId" = p_project AND a."personId" = p_person AND a."role" = 'MEMBER'
        AND a."validFrom" = run.until AND a."validUntil" IS DISTINCT FROM a."validFrom"
    WHERE run.until IS NOT NULL AND run.depth < 10000
  )
  SELECT EXISTS (SELECT 1 FROM run),
    CASE WHEN EXISTS (SELECT 1 FROM run) THEN (SELECT until FROM run ORDER BY depth DESC LIMIT 1) ELSE p_at END
$$;

-- A crew ends once; nothing else about it changes and it is never deleted.
CREATE FUNCTION crew_end_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'crews are never deleted'; END IF;
  IF OLD."activeUntil" IS NOT NULL OR NEW."activeUntil" IS NULL OR NEW."activeUntil" < now()
    OR (to_jsonb(NEW) - 'activeUntil') IS DISTINCT FROM (to_jsonb(OLD) - 'activeUntil') THEN
    RAISE EXCEPTION 'a crew can only be ended, once, at now() or later';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER crew_end_once BEFORE UPDATE OR DELETE ON "Crew" FOR EACH ROW EXECUTE FUNCTION crew_end_once();

-- ---------- entry code ----------
-- 128-bit, one active per project, PM-rotated; it allows only the roster read and bind.
CREATE TABLE "FieldEntryCode" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "createdBy" UUID NOT NULL,
  "retiredAt" TIMESTAMPTZ(6),
  "retiredBy" UUID,
  CONSTRAINT "FieldEntryCode_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "FieldEntryCode_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FieldEntryCode_orgId_createdBy_fkey" FOREIGN KEY ("orgId", "createdBy") REFERENCES "LoginAccount"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FieldEntryCode_orgId_retiredBy_fkey" FOREIGN KEY ("orgId", "retiredBy") REFERENCES "LoginAccount"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FieldEntryCode_code_check" CHECK ("code" ~ '^[A-Za-z0-9_-]{22}$'),
  CONSTRAINT "FieldEntryCode_retired_check" CHECK (("retiredAt" IS NULL) = ("retiredBy" IS NULL))
);
CREATE UNIQUE INDEX "FieldEntryCode_orgId_id_key" ON "FieldEntryCode"("orgId", "id");
CREATE UNIQUE INDEX "FieldEntryCode_code_key" ON "FieldEntryCode"("code");
CREATE UNIQUE INDEX "FieldEntryCode_active_key" ON "FieldEntryCode"("orgId", "projectId") WHERE "retiredAt" IS NULL;
CREATE FUNCTION field_entry_code_retire_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'entry codes are never deleted'; END IF;
  IF OLD."retiredAt" IS NOT NULL OR NEW."retiredAt" IS NULL
    OR (to_jsonb(NEW) - 'retiredAt' - 'retiredBy') IS DISTINCT FROM (to_jsonb(OLD) - 'retiredAt' - 'retiredBy') THEN
    RAISE EXCEPTION 'an entry code can only be retired, once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER field_entry_code_retire_once BEFORE UPDATE OR DELETE ON "FieldEntryCode"
  FOR EACH ROW EXECUTE FUNCTION field_entry_code_retire_once();

-- ---------- devices ----------
CREATE TABLE "FieldDevice" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "personId" UUID NOT NULL,
  "state" TEXT NOT NULL,
  -- sha256 hex of the current token; the previous one only for the exact rotation replay.
  "tokenHash" CHAR(64) NOT NULL,
  "prevTokenHash" CHAR(64),
  "rotatedAt" TIMESTAMPTZ(6),
  "generation" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "pendingUntil" TIMESTAMPTZ(6) NOT NULL,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  -- End of the person's continuous MEMBER run that contained now at the last roster write.
  "memberUntil" TIMESTAMPTZ(6),
  "lastSeenAt" TIMESTAMPTZ(6) NOT NULL,
  "confirmedAt" TIMESTAMPTZ(6),
  "confirmedByPersonId" UUID,
  "confirmedByAccountId" UUID,
  "confirmedByDeviceId" UUID,
  "endedAt" TIMESTAMPTZ(6),
  "endReason" TEXT,
  -- Lifecycle transitions only (bind, confirm, end); not activity, memberUntil or rotation.
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "FieldDevice_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "FieldDevice_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FieldDevice_orgId_personId_fkey" FOREIGN KEY ("orgId", "personId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FieldDevice_orgId_confirmedByPersonId_fkey" FOREIGN KEY ("orgId", "confirmedByPersonId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FieldDevice_orgId_confirmedByAccountId_fkey" FOREIGN KEY ("orgId", "confirmedByAccountId") REFERENCES "LoginAccount"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FieldDevice_state_check" CHECK ("state" IN ('PENDING', 'CONFIRMED', 'REJECTED', 'REVOKED', 'EXPIRED')),
  CONSTRAINT "FieldDevice_hash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'
    AND ("prevTokenHash" IS NULL OR ("prevTokenHash" ~ '^[0-9a-f]{64}$' AND "prevTokenHash" <> "tokenHash" AND "rotatedAt" IS NOT NULL))),
  CONSTRAINT "FieldDevice_confirmed_check" CHECK ("state" <> 'CONFIRMED' OR ("confirmedAt" IS NOT NULL AND "confirmedByPersonId" IS NOT NULL
    AND (("confirmedByAccountId" IS NULL) <> ("confirmedByDeviceId" IS NULL)))),
  CONSTRAINT "FieldDevice_not_self_check" CHECK ("confirmedByPersonId" IS NULL OR "confirmedByPersonId" <> "personId"),
  CONSTRAINT "FieldDevice_ended_check" CHECK (("state" IN ('PENDING', 'CONFIRMED')) = ("endedAt" IS NULL)
    AND ("endedAt" IS NULL) = ("endReason" IS NULL)),
  CONSTRAINT "FieldDevice_endReason_check" CHECK ("endReason" IN ('REJECTED', 'SUPERSEDED', 'REVOKED', 'RELEASED', 'REPLACED', 'UNASSIGNED', 'PENDING_TIMEOUT', 'LIFETIME', 'IDLE'))
);
CREATE UNIQUE INDEX "FieldDevice_orgId_id_key" ON "FieldDevice"("orgId", "id");
CREATE UNIQUE INDEX "FieldDevice_orgId_projectId_id_key" ON "FieldDevice"("orgId", "projectId", "id");
CREATE UNIQUE INDEX "FieldDevice_tokenHash_key" ON "FieldDevice"("tokenHash");
CREATE UNIQUE INDEX "FieldDevice_prevTokenHash_key" ON "FieldDevice"("prevTokenHash");
CREATE INDEX "FieldDevice_person_idx" ON "FieldDevice"("orgId", "projectId", "personId");
-- One confirmed device per person and project.
CREATE UNIQUE INDEX "FieldDevice_confirmed_key" ON "FieldDevice"("orgId", "projectId", "personId") WHERE "state" = 'CONFIRMED';
ALTER TABLE "FieldDevice" ADD CONSTRAINT "FieldDevice_orgId_projectId_confirmedByDeviceId_fkey" FOREIGN KEY ("orgId", "projectId", "confirmedByDeviceId") REFERENCES "FieldDevice"("orgId", "projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Forward-only lifecycle; terminal rows never change again (except clearing the recovery hash);
-- an elapsed membership end never moves, so a reassignment after a gap never revives a device.
CREATE FUNCTION field_device_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'field devices are never deleted'; END IF;
  IF (to_jsonb(NEW) - ARRAY['state', 'tokenHash', 'prevTokenHash', 'rotatedAt', 'generation', 'memberUntil', 'lastSeenAt',
      'confirmedAt', 'confirmedByPersonId', 'confirmedByAccountId', 'confirmedByDeviceId', 'endedAt', 'endReason', 'version'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'tokenHash', 'prevTokenHash', 'rotatedAt', 'generation', 'memberUntil', 'lastSeenAt',
      'confirmedAt', 'confirmedByPersonId', 'confirmedByAccountId', 'confirmedByDeviceId', 'endedAt', 'endReason', 'version']) THEN
    RAISE EXCEPTION 'a field device keeps its identity and deadlines';
  END IF;
  IF OLD."state" IN ('REJECTED', 'REVOKED', 'EXPIRED') THEN
    IF (to_jsonb(NEW) - 'prevTokenHash') IS DISTINCT FROM (to_jsonb(OLD) - 'prevTokenHash')
      OR NEW."prevTokenHash" IS DISTINCT FROM OLD."prevTokenHash" AND NEW."prevTokenHash" IS NOT NULL THEN
      RAISE EXCEPTION 'an ended field device never changes';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."state" <> OLD."state" AND NOT ((OLD."state" = 'PENDING' AND NEW."state" IN ('CONFIRMED', 'REJECTED', 'EXPIRED'))
    OR (OLD."state" = 'CONFIRMED' AND NEW."state" IN ('REVOKED', 'EXPIRED'))) THEN
    RAISE EXCEPTION 'field device states only move forward';
  END IF;
  IF NEW."memberUntil" IS DISTINCT FROM OLD."memberUntil" AND OLD."memberUntil" IS NOT NULL AND OLD."memberUntil" <= now() THEN
    RAISE EXCEPTION 'an elapsed membership end never moves';
  END IF;
  IF NEW."tokenHash" <> OLD."tokenHash" AND (NEW."prevTokenHash" IS DISTINCT FROM OLD."tokenHash" OR NEW."generation" <> OLD."generation" + 1) THEN
    RAISE EXCEPTION 'a token changes only by rotation';
  END IF;
  IF NEW."lastSeenAt" < OLD."lastSeenAt" OR NEW."version" < OLD."version" OR NEW."generation" < OLD."generation" THEN
    RAISE EXCEPTION 'field device counters never move back';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER field_device_forward_only BEFORE UPDATE OR DELETE ON "FieldDevice"
  FOR EACH ROW EXECUTE FUNCTION field_device_guard();

-- Every hash ever accepted, so a replayed or chosen token never matches another device.
CREATE TABLE "FieldTokenHash" (
  "hash" CHAR(64) NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL,
  "deviceId" UUID NOT NULL,
  "acceptedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "FieldTokenHash_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "FieldTokenHash_orgId_deviceId_fkey" FOREIGN KEY ("orgId", "deviceId") REFERENCES "FieldDevice"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FieldTokenHash_hash_check" CHECK ("hash" ~ '^[0-9a-f]{64}$')
);
CREATE TRIGGER field_token_hash_append_only BEFORE UPDATE OR DELETE ON "FieldTokenHash" FOR EACH ROW EXECUTE FUNCTION deny_change();

-- Hashed 6-digit codes bound to (device, device version, person, project); 5 minutes, single use.
CREATE TABLE "FieldConfirmChallenge" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "personId" UUID NOT NULL,
  "deviceId" UUID NOT NULL,
  "deviceVersion" INTEGER NOT NULL,
  "codeHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "usedAt" TIMESTAMPTZ(6),
  "supersededAt" TIMESTAMPTZ(6),
  CONSTRAINT "FieldConfirmChallenge_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "FieldConfirmChallenge_orgId_projectId_deviceId_fkey" FOREIGN KEY ("orgId", "projectId", "deviceId") REFERENCES "FieldDevice"("orgId", "projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FieldConfirmChallenge_orgId_personId_fkey" FOREIGN KEY ("orgId", "personId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FieldConfirmChallenge_hash_check" CHECK ("codeHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "FieldConfirmChallenge_once_check" CHECK ("usedAt" IS NULL OR "supersededAt" IS NULL)
);
-- One person's live codes always differ.
CREATE UNIQUE INDEX "FieldConfirmChallenge_live_key" ON "FieldConfirmChallenge"("orgId", "projectId", "personId", "codeHash")
  WHERE "usedAt" IS NULL AND "supersededAt" IS NULL;
CREATE INDEX "FieldConfirmChallenge_device_idx" ON "FieldConfirmChallenge"("orgId", "deviceId");
CREATE FUNCTION field_challenge_end_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'challenges are never deleted'; END IF;
  IF OLD."usedAt" IS NOT NULL OR OLD."supersededAt" IS NOT NULL
    OR (to_jsonb(NEW) - 'usedAt' - 'supersededAt') IS DISTINCT FROM (to_jsonb(OLD) - 'usedAt' - 'supersededAt') THEN
    RAISE EXCEPTION 'a challenge is used or superseded once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER field_challenge_end_once BEFORE UPDATE OR DELETE ON "FieldConfirmChallenge"
  FOR EACH ROW EXECUTE FUNCTION field_challenge_end_once();

-- Failed matches per person, across all of the person's live challenges.
CREATE TABLE "FieldPersonConfirm" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "personId" UUID NOT NULL,
  "failures" INTEGER NOT NULL DEFAULT 0,
  "windowStart" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "FieldPersonConfirm_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "FieldPersonConfirm_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FieldPersonConfirm_orgId_personId_fkey" FOREIGN KEY ("orgId", "personId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FieldPersonConfirm_failures_check" CHECK ("failures" BETWEEN 0 AND 5)
);
CREATE UNIQUE INDEX "FieldPersonConfirm_orgId_projectId_personId_key" ON "FieldPersonConfirm"("orgId", "projectId", "personId");

-- Lifecycle and refusal events; never coordinates, codes, tokens, hashes or names.
CREATE TABLE "FieldDeviceEvent" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "deviceId" UUID,
  "personId" UUID,
  "kind" TEXT NOT NULL,
  "reasonCode" TEXT,
  "at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "actorAccountId" UUID,
  "actorPersonId" UUID,
  "actorDeviceId" UUID,
  "seq" BIGINT GENERATED ALWAYS AS IDENTITY,
  CONSTRAINT "FieldDeviceEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "FieldDeviceEvent_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FieldDeviceEvent_orgId_projectId_deviceId_fkey" FOREIGN KEY ("orgId", "projectId", "deviceId") REFERENCES "FieldDevice"("orgId", "projectId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FieldDeviceEvent_orgId_personId_fkey" FOREIGN KEY ("orgId", "personId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FieldDeviceEvent_orgId_actorAccountId_fkey" FOREIGN KEY ("orgId", "actorAccountId") REFERENCES "LoginAccount"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT "FieldDeviceEvent_kind_check" CHECK ("kind" IN ('BIND', 'CHALLENGE', 'CHALLENGE_FAILED', 'CHALLENGES_RESET', 'CONFIRM',
    'REJECT', 'REVOKE', 'RELEASE', 'ROTATE', 'EXPIRE', 'REPLACE', 'SUPERSEDE', 'UNASSIGN')),
  CONSTRAINT "FieldDeviceEvent_reason_check" CHECK ("reasonCode" ~ '^[A-Z_]{1,40}$')
);
CREATE INDEX "FieldDeviceEvent_device_idx" ON "FieldDeviceEvent"("orgId", "deviceId", "seq");
CREATE TRIGGER field_device_event_append_only BEFORE UPDATE OR DELETE ON "FieldDeviceEvent" FOR EACH ROW EXECUTE FUNCTION deny_change();

-- ---------- throttling (before authentication, so not tenant data) ----------
-- Fixed windows keyed by salted hashes (client IP, entry code, device token); the daily salt
-- and every window older than 48 h are deleted, so nothing links back to a client or person.
CREATE TABLE "FieldThrottle" (
  "bucket" TEXT NOT NULL,
  "windowStart" TIMESTAMPTZ(6) NOT NULL,
  "count" INTEGER NOT NULL,
  CONSTRAINT "FieldThrottle_pkey" PRIMARY KEY ("bucket", "windowStart"),
  CONSTRAINT "FieldThrottle_bucket_check" CHECK ("bucket" ~ '^[a-z-]{1,24}:[0-9a-f-]{1,64}$')
);
CREATE INDEX "FieldThrottle_windowStart_idx" ON "FieldThrottle"("windowStart");
CREATE TABLE "FieldThrottleSalt" (
  "day" DATE NOT NULL PRIMARY KEY,
  "salt" TEXT NOT NULL
);

-- ---------- grants and row-level security ----------
GRANT SELECT, INSERT ON "Crew", "CrewAssignment", "ProjectRoster", "FieldEntryCode", "FieldDevice",
  "FieldTokenHash", "FieldConfirmChallenge", "FieldPersonConfirm", "FieldDeviceEvent" TO mje_alpha_app;
GRANT UPDATE ("activeUntil") ON "Crew" TO mje_alpha_app;
GRANT UPDATE ("validUntil", "closedBy") ON "CrewAssignment" TO mje_alpha_app;
GRANT UPDATE ("version", "updatedAt") ON "ProjectRoster" TO mje_alpha_app;
GRANT UPDATE ("retiredAt", "retiredBy") ON "FieldEntryCode" TO mje_alpha_app;
GRANT UPDATE ("state", "tokenHash", "prevTokenHash", "rotatedAt", "generation", "memberUntil", "lastSeenAt",
  "confirmedAt", "confirmedByPersonId", "confirmedByAccountId", "confirmedByDeviceId", "endedAt", "endReason", "version")
  ON "FieldDevice" TO mje_alpha_app;
GRANT UPDATE ("usedAt", "supersededAt") ON "FieldConfirmChallenge" TO mje_alpha_app;
GRANT UPDATE ("failures", "windowStart") ON "FieldPersonConfirm" TO mje_alpha_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "FieldThrottle", "FieldThrottleSalt" TO mje_alpha_app;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['Crew', 'CrewAssignment', 'ProjectRoster', 'FieldEntryCode', 'FieldDevice',
    'FieldTokenHash', 'FieldConfirmChallenge', 'FieldPersonConfirm', 'FieldDeviceEvent'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY alpha_org ON %I TO mje_alpha_app USING ("orgId"::text = current_setting(''app.org_id'', true)) WITH CHECK ("orgId"::text = current_setting(''app.org_id'', true))', table_name);
  END LOOP;
END $$;
-- Bootstrap lookups before the org is known: SELECT only, one row per secret.
CREATE POLICY field_device_lookup ON "FieldDevice" FOR SELECT TO mje_alpha_app
  USING ("tokenHash" = current_setting('app.device_token_hash', true) OR "prevTokenHash" = current_setting('app.device_token_hash', true));
CREATE POLICY field_entry_lookup ON "FieldEntryCode" FOR SELECT TO mje_alpha_app
  USING ("retiredAt" IS NULL AND "code" = current_setting('app.entry_code', true));
