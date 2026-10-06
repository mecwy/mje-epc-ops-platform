-- C03 additive queue access. Previously applied 001 is unchanged.
-- No access to non-weather events or payload/scope rewrites is granted.
ALTER TABLE "OutboxEvent" ENABLE ROW LEVEL SECURITY;
CREATE POLICY c03_weather_outbox ON "OutboxEvent" TO mje_alpha_app
USING (
 "eventType"='WEATHER_FETCH'
 AND "orgId"::text=current_setting('app.org_id',true)
 AND payload=jsonb_build_object('requestId',"aggregateId"::text)
 AND EXISTS (SELECT 1 FROM "WeatherRequest" r
   WHERE r."orgId"="OutboxEvent"."orgId"
   AND r.id="OutboxEvent"."aggregateId"
   AND r."refreshGeneration"="OutboxEvent"."aggregateVersion")
)
WITH CHECK (
 "eventType"='WEATHER_FETCH'
 AND "orgId"::text=current_setting('app.org_id',true)
 AND payload=jsonb_build_object('requestId',"aggregateId"::text)
 AND EXISTS (SELECT 1 FROM "WeatherRequest" r
   WHERE r."orgId"="OutboxEvent"."orgId"
   AND r.id="OutboxEvent"."aggregateId"
   AND r."refreshGeneration"="OutboxEvent"."aggregateVersion")
);
GRANT SELECT,INSERT ON "OutboxEvent" TO mje_alpha_app;
GRANT UPDATE("processedAt","availableAt",attempts) ON "OutboxEvent" TO mje_alpha_app;
