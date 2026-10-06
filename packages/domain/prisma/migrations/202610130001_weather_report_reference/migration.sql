-- C03: approved site-purpose weather points are distinct from personal reporting positions.
-- Additive only; rollback preserves rows and existing revisions.
CREATE UNIQUE INDEX "DailyClose_weather_scope_key" ON "DailyClose"("orgId","projectId","businessDate","siteTimezone",id);
CREATE TABLE "WeatherLocationVersion" (
 id UUID PRIMARY KEY,"orgId" UUID NOT NULL,"projectId" UUID NOT NULL,"scopeKey" TEXT NOT NULL,n INTEGER NOT NULL CHECK(n>0),
 "siteTimezone" TEXT NOT NULL,lat NUMERIC(20,12) NOT NULL CHECK(lat BETWEEN -90 AND 90),lon NUMERIC(20,12) NOT NULL CHECK(lon BETWEEN -180 AND 180),
 "rawLat" TEXT NOT NULL CHECK("rawLat" ~ '^-?[0-9]{1,3}(\.[0-9]{1,12})?$' AND "rawLat"::numeric=lat),
 "rawLon" TEXT NOT NULL CHECK("rawLon" ~ '^-?[0-9]{1,3}(\.[0-9]{1,12})?$' AND "rawLon"::numeric=lon),
 purpose TEXT NOT NULL DEFAULT 'weather' CHECK(purpose='weather'),"confirmedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 "confirmedByAccountId" UUID NOT NULL,"confirmedByPersonId" UUID NOT NULL,
 UNIQUE("orgId",id),UNIQUE("orgId","projectId","scopeKey",n),UNIQUE("orgId","projectId","siteTimezone",id),
 FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","projectId") REFERENCES "Project"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","confirmedByAccountId") REFERENCES "LoginAccount"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","confirmedByPersonId") REFERENCES "Person"("orgId",id) ON DELETE RESTRICT
);
CREATE TABLE "WeatherRequest" (
 id UUID PRIMARY KEY,"orgId" UUID NOT NULL,"projectId" UUID NOT NULL,"locationVersionId" UUID NOT NULL,"businessDate" DATE NOT NULL,"siteTimezone" TEXT NOT NULL,
 product TEXT NOT NULL CHECK(product IN ('historical-weather','forecast')),model TEXT NOT NULL CHECK(model IN ('era5','ifs','forecast')),units TEXT NOT NULL DEFAULT 'original',
 "refreshGeneration" INTEGER NOT NULL CHECK("refreshGeneration">0),query JSONB NOT NULL,
 state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','FETCHING','READY','NO_HISTORY','UNAVAILABLE','RATE_LIMITED','DISABLED')),
 "leaseToken" UUID,"leasedUntil" TIMESTAMPTZ,attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 2),"nextAttemptAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 "terminalCode" TEXT,"requestedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),"requestedByAccountId" UUID NOT NULL,"requestedByPersonId" UUID NOT NULL,
 CHECK((state='FETCHING')=("leaseToken" IS NOT NULL AND "leasedUntil" IS NOT NULL)),
 CHECK((product='forecast')=(model='forecast')),
 UNIQUE("orgId",id),UNIQUE("orgId","projectId","businessDate","siteTimezone","locationVersionId",id),
 UNIQUE("orgId","projectId","locationVersionId","businessDate","siteTimezone",product,model,units,"refreshGeneration"),
 FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","projectId","siteTimezone","locationVersionId") REFERENCES "WeatherLocationVersion"("orgId","projectId","siteTimezone",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","requestedByAccountId") REFERENCES "LoginAccount"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","requestedByPersonId") REFERENCES "Person"("orgId",id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "WeatherRequest_active_key" ON "WeatherRequest"("orgId","projectId","locationVersionId","businessDate","siteTimezone",product,model,units) WHERE state IN ('PENDING','FETCHING');
CREATE INDEX "WeatherRequest_claim_idx" ON "WeatherRequest"("orgId",state,"nextAttemptAt","leasedUntil");
CREATE TABLE "WeatherSnapshot" (
 id UUID PRIMARY KEY,"orgId" UUID NOT NULL,"projectId" UUID NOT NULL,"locationVersionId" UUID NOT NULL,"requestId" UUID NOT NULL,"businessDate" DATE NOT NULL,"siteTimezone" TEXT NOT NULL,
 data JSONB NOT NULL,"fetchedAt" TIMESTAMPTZ NOT NULL,"publishedAt" TIMESTAMPTZ,"adapterVersion" TEXT NOT NULL,"responseHash" CHAR(64) NOT NULL CHECK("responseHash" ~ '^[a-f0-9]{64}$'),"sourceLink" TEXT NOT NULL,"licenseLink" TEXT NOT NULL,
 UNIQUE("orgId",id),UNIQUE("orgId","requestId"),UNIQUE("orgId","projectId","businessDate","siteTimezone","locationVersionId",id),
 FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","projectId","businessDate","siteTimezone","locationVersionId","requestId") REFERENCES "WeatherRequest"("orgId","projectId","businessDate","siteTimezone","locationVersionId",id) ON DELETE RESTRICT
);
CREATE TABLE "WeatherReportReference" (
 id UUID PRIMARY KEY,"orgId" UUID NOT NULL,"projectId" UUID NOT NULL,"dailyCloseId" UUID NOT NULL,"businessDate" DATE NOT NULL,"siteTimezone" TEXT NOT NULL,"locationVersionId" UUID NOT NULL,"snapshotId" UUID NOT NULL,
 "adoptedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),"adoptedByAccountId" UUID NOT NULL,"adoptedByPersonId" UUID NOT NULL,"clientMutationId" UUID NOT NULL,
 UNIQUE("orgId",id),UNIQUE("orgId","projectId","businessDate","siteTimezone","dailyCloseId",id),UNIQUE("orgId","dailyCloseId","clientMutationId","snapshotId"),
 FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
 CONSTRAINT "WeatherReference_day_fkey" FOREIGN KEY("orgId","projectId","businessDate","siteTimezone","dailyCloseId") REFERENCES "DailyClose"("orgId","projectId","businessDate","siteTimezone",id) ON DELETE RESTRICT,
 CONSTRAINT "WeatherReference_snapshot_fkey" FOREIGN KEY("orgId","projectId","businessDate","siteTimezone","locationVersionId","snapshotId") REFERENCES "WeatherSnapshot"("orgId","projectId","businessDate","siteTimezone","locationVersionId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","adoptedByAccountId") REFERENCES "LoginAccount"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","adoptedByPersonId") REFERENCES "Person"("orgId",id) ON DELETE RESTRICT
);
CREATE TABLE "ReportLocationRecord" (
 id UUID PRIMARY KEY,"orgId" UUID NOT NULL,"projectId" UUID NOT NULL,"dailyCloseId" UUID NOT NULL,"businessDate" DATE NOT NULL,"siteTimezone" TEXT NOT NULL,
 lat NUMERIC(20,12) NOT NULL CHECK(lat BETWEEN -90 AND 90),lon NUMERIC(20,12) NOT NULL CHECK(lon BETWEEN -180 AND 180),
 "rawLat" TEXT NOT NULL CHECK("rawLat" ~ '^-?[0-9]{1,3}(\.[0-9]{1,12})?$' AND "rawLat"::numeric=lat),"rawLon" TEXT NOT NULL CHECK("rawLon" ~ '^-?[0-9]{1,3}(\.[0-9]{1,12})?$' AND "rawLon"::numeric=lon),
 "accuracyM" NUMERIC(20,6) NOT NULL CHECK("accuracyM">=0),"rawAccuracyM" TEXT NOT NULL CHECK("rawAccuracyM" ~ '^[0-9]{1,6}(\.[0-9]{1,2})?$' AND "rawAccuracyM"::numeric="accuracyM"),
 "deviceFixAt" TIMESTAMPTZ,"acquiredAt" TIMESTAMPTZ NOT NULL,"clientConfirmedAt" TIMESTAMPTZ NOT NULL,"serverReceivedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 "actorAccountId" UUID NOT NULL,"actorPersonId" UUID NOT NULL,"clientMutationId" UUID NOT NULL,"captureOrigin" TEXT NOT NULL DEFAULT 'user_initiated_report' CHECK("captureOrigin"='user_initiated_report'),
 UNIQUE("orgId",id),UNIQUE("orgId","projectId","businessDate","siteTimezone","dailyCloseId",id),UNIQUE("orgId","dailyCloseId","clientMutationId"),
 FOREIGN KEY("orgId") REFERENCES "Organization"(id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","projectId","businessDate","siteTimezone","dailyCloseId") REFERENCES "DailyClose"("orgId","projectId","businessDate","siteTimezone",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","actorAccountId") REFERENCES "LoginAccount"("orgId",id) ON DELETE RESTRICT,
 FOREIGN KEY("orgId","actorPersonId") REFERENCES "Person"("orgId",id) ON DELETE RESTRICT
);
CREATE FUNCTION weather_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN RAISE EXCEPTION 'weather history is append-only'; END $$;
CREATE FUNCTION weather_request_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['state','leaseToken','leasedUntil','attempts','nextAttemptAt','terminalCode']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','leaseToken','leasedUntil','attempts','nextAttemptAt','terminalCode']) THEN RAISE EXCEPTION 'weather request query is immutable'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER weather_request_immutable BEFORE UPDATE OR DELETE ON "WeatherRequest" FOR EACH ROW EXECUTE FUNCTION weather_request_immutable();
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['WeatherLocationVersion','WeatherRequest','WeatherSnapshot','WeatherReportReference','ReportLocationRecord'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY alpha_org ON %I TO mje_alpha_app USING ("orgId"::text=current_setting(''app.org_id'',true)) WITH CHECK ("orgId"::text=current_setting(''app.org_id'',true))',t);
 IF t<>'WeatherRequest' THEN EXECUTE format('CREATE TRIGGER weather_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION weather_append_only()',t); END IF;
 END LOOP;
END $$;
GRANT SELECT,INSERT ON "WeatherLocationVersion","WeatherRequest","WeatherSnapshot","WeatherReportReference","ReportLocationRecord" TO mje_alpha_app;
GRANT UPDATE(state,"leaseToken","leasedUntil",attempts,"nextAttemptAt","terminalCode") ON "WeatherRequest" TO mje_alpha_app;
REVOKE ALL ON FUNCTION weather_append_only(),weather_request_immutable() FROM PUBLIC;
