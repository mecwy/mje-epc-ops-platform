ALTER TABLE "Issue" ADD COLUMN "escalatedAt" TIMESTAMPTZ(6);

-- Recover the latest known activation time from the append-only audit history.
-- Issues without an escalation audit retain creation time as the conservative fallback.
UPDATE "Issue" i
SET "escalatedAt" = COALESCE(
  (
    SELECT a."occurredAt"
    FROM "AuditLog" a
    WHERE a."orgId"=i."orgId" AND a."entityType"='ISSUE' AND a."entityId"=i.id
      AND a.action='ISSUE_ESCALATE' AND a.after->>'escalate'='true'
    ORDER BY a."entityVersion" DESC
    LIMIT 1
  ),
  i."createdAt"
)
WHERE i.escalate;
