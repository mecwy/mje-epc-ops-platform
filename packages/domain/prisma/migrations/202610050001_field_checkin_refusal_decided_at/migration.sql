-- C29 failed check-in limit (additive; design docs/architecture/a6-field-devices-design.md §2,
-- §5 level 2a, C29). A refused check-in event records the decision time it was judged at, so
-- the per-device limit (30 per hour) counts refusals against their decision time, not the
-- transaction start (a refusal decided after a lock wait must count for a full hour from its
-- decision). Refusal events written before this migration have no decision time and are not
-- counted; the constraint applies to new rows only (NOT VALID), existing rows are unchanged.
ALTER TABLE "FieldDeviceEvent" ADD COLUMN "decidedAt" TIMESTAMPTZ(6);
ALTER TABLE "FieldDeviceEvent" ADD CONSTRAINT "FieldDeviceEvent_decidedAt_check"
  CHECK ((kind = 'CHECKIN_REFUSED') = ("decidedAt" IS NOT NULL)) NOT VALID;
-- The count: one device's refusals of the last hour.
CREATE INDEX "FieldDeviceEvent_checkin_refused_idx" ON "FieldDeviceEvent"("orgId", "deviceId", "decidedAt")
  WHERE kind = 'CHECKIN_REFUSED';
