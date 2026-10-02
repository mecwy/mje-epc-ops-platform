-- Keep the manager identity projection aligned with effective login-account state.
CREATE OR REPLACE FUNCTION project_managers_for_org()
RETURNS TABLE ("projectId" UUID, "personId" UUID, "displayName" TEXT)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog, public, pg_temp AS $$
  SELECT DISTINCT m."projectId", a."personId", p."displayName"
  FROM public."Membership" m
  JOIN public."LoginAccount" a ON a."orgId"=m."orgId" AND a.id=m."accountId"
  JOIN public."Person" p ON p."orgId"=a."orgId" AND p.id=a."personId"
  WHERE m."orgId"=pg_catalog.current_setting('app.org_id', true)::uuid
    AND m."projectId" IS NOT NULL
    AND m.role='PROJECT_MANAGER'
    AND a.active
    AND m."activeFrom"<=pg_catalog.current_setting('app.decided_at', true)::timestamptz
    AND (m."activeUntil" IS NULL OR m."activeUntil">pg_catalog.current_setting('app.decided_at', true)::timestamptz)
$$;
REVOKE ALL ON FUNCTION project_managers_for_org() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION project_managers_for_org() TO mje_alpha_app;
