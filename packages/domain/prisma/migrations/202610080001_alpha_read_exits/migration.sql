-- Alpha owns AlphaDraft; report owns the outer day/history statements.
-- STABLE keeps these reads in the caller statement snapshot at READ COMMITTED.
-- SECURITY INVOKER preserves existing table privileges and tenant RLS.
CREATE FUNCTION public.alpha_draft_exists(org_id UUID, record_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE STRICT SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public."AlphaDraft"
    WHERE "orgId" = $1 AND "dailyCloseId" = $2)
$$;
CREATE FUNCTION public.alpha_draft_content(org_id UUID, record_id UUID)
RETURNS JSONB LANGUAGE SQL STABLE STRICT SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT content FROM public."AlphaDraft"
    WHERE "orgId" = $1 AND "dailyCloseId" = $2
$$;
REVOKE ALL ON FUNCTION public.alpha_draft_exists(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.alpha_draft_content(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.alpha_draft_exists(UUID, UUID) TO mje_alpha_app;
GRANT EXECUTE ON FUNCTION public.alpha_draft_content(UUID, UUID) TO mje_alpha_app;
