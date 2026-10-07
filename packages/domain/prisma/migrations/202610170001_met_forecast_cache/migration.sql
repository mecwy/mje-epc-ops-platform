-- Durable MET supplier cache: mutable cache/leases, never report facts.
-- Only the existing application role receives the new table privileges.
CREATE TABLE "MetForecastCache" (
 "orgId" uuid NOT NULL, provider text NOT NULL, "pointHash" char(64) NOT NULL,
 body jsonb, "fetchedAt" timestamptz(6), "expiresAt" timestamptz(6), "lastModified" text,
 "leaseToken" uuid, "leasedUntil" timestamptz(6),
 CONSTRAINT "MetForecastCache_pkey" PRIMARY KEY("orgId",provider,"pointHash"),
 CONSTRAINT "MetForecastCache_orgId_fkey" FOREIGN KEY("orgId")
   REFERENCES "Organization"(id) ON UPDATE NO ACTION ON DELETE RESTRICT,
 CONSTRAINT met_cache_provider CHECK(provider='met-norway'),
 CONSTRAINT met_cache_point_hash CHECK("pointHash" ~ '^[0-9a-f]{64}$'),
 CONSTRAINT met_cache_payload_pair CHECK(
   (body IS NULL AND "fetchedAt" IS NULL AND "expiresAt" IS NULL AND "lastModified" IS NULL)
   OR (body IS NOT NULL AND "fetchedAt" IS NOT NULL AND "expiresAt" IS NOT NULL
       AND isfinite("fetchedAt") AND isfinite("expiresAt") AND "expiresAt">"fetchedAt")),
 CONSTRAINT met_cache_body_bound CHECK(body IS NULL OR
   (jsonb_typeof(body)='object' AND octet_length(body::text)<=2097152)),
 CONSTRAINT met_cache_last_modified_bound CHECK("lastModified" IS NULL OR octet_length("lastModified")<=200),
 CONSTRAINT met_cache_lease_pair CHECK(
   ("leaseToken" IS NULL AND "leasedUntil" IS NULL)
   OR ("leaseToken" IS NOT NULL AND "leasedUntil" IS NOT NULL AND isfinite("leasedUntil")))
);
CREATE TABLE "MetForecastCooldown" (
 "orgId" uuid NOT NULL, provider text NOT NULL, "until" timestamptz(6),
 CONSTRAINT "MetForecastCooldown_pkey" PRIMARY KEY("orgId",provider),
 CONSTRAINT "MetForecastCooldown_orgId_fkey" FOREIGN KEY("orgId")
   REFERENCES "Organization"(id) ON UPDATE NO ACTION ON DELETE RESTRICT,
 CONSTRAINT met_cooldown_provider CHECK(provider='met-norway'),
 CONSTRAINT met_cooldown_until_finite CHECK("until" IS NULL OR isfinite("until"))
);
ALTER TABLE "MetForecastCache" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MetForecastCache" FORCE ROW LEVEL SECURITY;
ALTER TABLE "MetForecastCooldown" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MetForecastCooldown" FORCE ROW LEVEL SECURITY;
CREATE POLICY met_cache_org ON "MetForecastCache" TO mje_alpha_app
 USING ("orgId"::text=current_setting('app.org_id',true))
 WITH CHECK ("orgId"::text=current_setting('app.org_id',true));
CREATE POLICY met_cooldown_org ON "MetForecastCooldown" TO mje_alpha_app
 USING ("orgId"::text=current_setting('app.org_id',true))
 WITH CHECK ("orgId"::text=current_setting('app.org_id',true));
GRANT SELECT,INSERT,UPDATE ON "MetForecastCache","MetForecastCooldown" TO mje_alpha_app;
