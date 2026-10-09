-- Applied 210001 remains immutable. Align this trigger with the existing approved function policy.
-- Catalog resolves built-ins first; pg_temp last prevents temporary objects shadowing public objects.
ALTER FUNCTION public.material_movement_immutable() SET search_path TO pg_catalog, public, pg_temp;
