-- C29 failed check-in limit (additive; design docs/architecture/a6-field-devices-design.md §2,
-- §5 level 2a, C29). A refused check-in event records the decision time it was judged at, so
-- the per-device limit (30 per hour) counts refusals against their decision time, not the
-- transaction start (a refusal decided after a lock wait must count for a full hour from its
-- decision). Nullable and without a constraint, so the previous image (which writes refusal
-- events without it) stays compatible for a rollback; such events are simply not counted.
ALTER TABLE "FieldDeviceEvent" ADD COLUMN "decidedAt" TIMESTAMPTZ(6);
-- The count: one device's refusals of the last hour.
CREATE INDEX "FieldDeviceEvent_checkin_refused_idx" ON "FieldDeviceEvent"("orgId", "deviceId", "decidedAt")
  WHERE kind = 'CHECKIN_REFUSED';
