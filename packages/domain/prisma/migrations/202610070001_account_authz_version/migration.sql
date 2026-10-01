-- A7-0b account authorization version and first account lock (ADR-0003 D5; additive).
-- authzVersion moves forward in the same transaction as every grant or revocation write, so no
-- writer has to remember it: a Membership insert, update or delete bumps the affected account
-- (old and new account when the row moves), and a change of LoginAccount.active, personId,
-- entraTenantId, entraObjectId or orgId (who the account is, and where) bumps the row itself. Function bodies pin search_path (pg_catalog first, pg_temp last) and
-- qualify table names, so a caller's temporary table cannot shadow them (202610030001 pattern).
ALTER TABLE "LoginAccount" ADD COLUMN "authzVersion" INTEGER NOT NULL DEFAULT 1;

-- BEFORE UPDATE on the row itself: it adjusts NEW instead of issuing another UPDATE, so it
-- cannot recurse. The version never moves back.
CREATE FUNCTION login_account_authz_version() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW."authzVersion" < OLD."authzVersion" THEN
    RAISE EXCEPTION 'the account authorization version never moves back';
  END IF;
  IF NEW.active IS DISTINCT FROM OLD.active OR NEW."personId" IS DISTINCT FROM OLD."personId"
    OR NEW."entraTenantId" IS DISTINCT FROM OLD."entraTenantId"
    OR NEW."entraObjectId" IS DISTINCT FROM OLD."entraObjectId"
    OR NEW."orgId" IS DISTINCT FROM OLD."orgId" THEN
    NEW."authzVersion" := NEW."authzVersion" + 1;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER login_account_authz_version BEFORE UPDATE ON "LoginAccount"
  FOR EACH ROW EXECUTE FUNCTION login_account_authz_version();

-- Runs as the Membership writer (not a definer): a role that may not update LoginAccount cannot
-- change memberships either. The UPDATE takes the account row lock, so a revocation waits for
-- any transaction holding the share lock from app_account_for_identity() and then commits a
-- higher version. The bump only changes authzVersion, so the row trigger above adds nothing.
CREATE FUNCTION membership_authz_version() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE public."LoginAccount" SET "authzVersion" = "authzVersion" + 1
    WHERE id = OLD."accountId" AND "orgId" = OLD."orgId";
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE'
    AND (NEW."accountId", NEW."orgId") IS DISTINCT FROM (OLD."accountId", OLD."orgId")) THEN
    UPDATE public."LoginAccount" SET "authzVersion" = "authzVersion" + 1
    WHERE id = NEW."accountId" AND "orgId" = NEW."orgId";
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER membership_authz_version AFTER INSERT OR UPDATE OR DELETE ON "Membership"
  FOR EACH ROW EXECUTE FUNCTION membership_authz_version();
-- Triggers fire without an EXECUTE check; nobody calls these directly.
REVOKE ALL ON FUNCTION login_account_authz_version() FROM PUBLIC;
REVOKE ALL ON FUNCTION membership_authz_version() FROM PUBLIC;

-- The application role keeps SELECT only on LoginAccount (202609280001), and SELECT ... FOR
-- SHARE needs UPDATE on the table, so the first lock of every account transaction is taken here.
-- The function is owned by the migration role, which owns LoginAccount and is therefore not
-- subject to its row-level security; the body re-applies the alpha_identity policy itself (an
-- active account whose Entra identity equals the session's app.tenant_id / app.object_id), so
-- it returns nothing the caller could not already SELECT, and only these four columns. The row
-- lock belongs to the calling transaction and is held until it ends. No dynamic SQL.
CREATE FUNCTION app_account_for_identity(tenant TEXT, oid TEXT)
RETURNS TABLE ("orgId" UUID, id UUID, "personId" UUID, "authzVersion" INTEGER)
LANGUAGE sql STRICT SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT a."orgId", a.id, a."personId", a."authzVersion"
  FROM public."LoginAccount" a
  WHERE a.active AND a."entraTenantId" = $1 AND a."entraObjectId" = $2 AND a."personId" IS NOT NULL
    AND $1 = pg_catalog.current_setting('app.tenant_id', true)
    AND $2 = pg_catalog.current_setting('app.object_id', true)
  FOR SHARE OF a
$$;
REVOKE ALL ON FUNCTION app_account_for_identity(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_account_for_identity(TEXT, TEXT) TO mje_alpha_app;
