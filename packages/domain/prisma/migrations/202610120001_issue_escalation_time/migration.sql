ALTER TABLE "Issue" ADD COLUMN "escalatedAt" TIMESTAMPTZ(6);

-- Recover the latest known activation time from the append-only audit history.
-- Keep unknown history NULL. Recover only auditable rising edges: an already-true
-- repeated escalation and later edits must not move the activation time.
UPDATE "Issue" i
SET "escalatedAt" = (
  SELECT a."occurredAt"
  FROM "AuditLog" a
  WHERE a."orgId"=i."orgId" AND a."entityType"='ISSUE' AND a."entityId"=i.id
    AND (
      (a.action='ISSUE_CREATE' AND a.after->>'escalate'='true')
      OR (a.action='ISSUE_ESCALATE' AND a.before->>'escalate'='false' AND a.after->>'escalate'='true')
    )
  ORDER BY a."entityVersion" DESC
  LIMIT 1
)
WHERE i.escalate;
