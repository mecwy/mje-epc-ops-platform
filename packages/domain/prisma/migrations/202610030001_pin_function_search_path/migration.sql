-- Pin search_path on every database function defined by earlier migrations that did not pin
-- it. Unpinned functions resolve unqualified table names through the caller's search_path, and
-- a caller's temporary schema can hold a same-named temporary table (for example a temporary
-- "CrewAssignment" hiding the real one inside the overlap check). With pg_catalog first, public
-- next and pg_temp last, a temporary table can no longer shadow a public table. Bodies are
-- unchanged; functions added by 202610020001 already pin their own path.
ALTER FUNCTION public.deny_change() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.protect_revision() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.evidence_link_supersede_only() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.crew_assignment_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.field_member_run(UUID, UUID, UUID, TIMESTAMPTZ) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.crew_end_once() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.field_entry_code_retire_once() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.field_challenge_end_once() SET search_path = pg_catalog, public, pg_temp;
