-- U2.1 issues and escalation (additive). Site-report issues reuse the Phase 0 "Issue" table
-- (summary = title, ownerPersonId = owner, kind = 'SITE_REPORT'); notes and replies are an
-- append-only table; closes and reopens are append-only effective-dated transitions, so the
-- status of an issue on any earlier business day survives a reopen; a dismissed lag reminder is
-- recorded per project, business day and item.
-- Existing tables, roles and policies are untouched apart from the columns added to "Issue".

-- A project-manager close is not a verification: it gets its own state. The new value is not
-- used anywhere in this migration.
ALTER TYPE "IssueState" ADD VALUE IF NOT EXISTS 'CLOSED';

ALTER TABLE "Issue"
  ADD COLUMN "category" TEXT,
  ADD COLUMN "escalate" BOOLEAN NOT NULL DEFAULT false,
  -- Needs an expert (e.g. safety or quality) to close; the project manager cannot.
  ADD COLUMN "controlled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "workItemKey" TEXT,
  -- Site business dates, never the server receive date.
  ADD COLUMN "createdOn" DATE,
  ADD COLUMN "dueOn" DATE,
  ADD COLUMN "closedOn" DATE,
  ADD COLUMN "closedBy" UUID,
  -- Creation order. Database clocks can step backwards (NTP), so order never relies on createdAt.
  ADD COLUMN "seq" BIGINT GENERATED ALWAYS AS IDENTITY,
  ADD CONSTRAINT "Issue_category_check" CHECK ("category" IN ('progressLag', 'milestoneRisk', 'safety', 'quality', 'externalStop', 'resourceGap', 'costChange', 'subDispute')),
  ADD CONSTRAINT "Issue_escalate_category_check" CHECK (NOT "escalate" OR "category" IS NOT NULL),
  ADD CONSTRAINT "Issue_workItemKey_check" CHECK ("workItemKey" ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
  ADD CONSTRAINT "Issue_closed_pair_check" CHECK (("closedOn" IS NULL) = ("closedBy" IS NULL)),
  ADD CONSTRAINT "Issue_closedOn_check" CHECK ("closedOn" IS NULL OR "createdOn" IS NULL OR "closedOn" >= "createdOn"),
  ADD CONSTRAINT "Issue_closedBy_fkey" FOREIGN KEY ("orgId", "closedBy") REFERENCES "LoginAccount"("orgId", "id") ON DELETE RESTRICT;
CREATE INDEX "Issue_project_createdOn_idx" ON "Issue"("orgId", "projectId", "createdOn", "seq");

CREATE TABLE "IssueNote" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL REFERENCES "Organization"("id") ON DELETE RESTRICT,
  "issueId" UUID NOT NULL,
  -- 'note' by the project manager, 'reply' by an executive reader.
  "kind" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "onDate" DATE NOT NULL,
  "authorAccountId" UUID NOT NULL,
  "authorPersonId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Append order ("last note"); not the clock.
  "seq" BIGINT GENERATED ALWAYS AS IDENTITY,
  CONSTRAINT "IssueNote_orgId_id_key" UNIQUE ("orgId", "id"),
  CONSTRAINT "IssueNote_issue_fkey" FOREIGN KEY ("orgId", "issueId") REFERENCES "Issue"("orgId", "id") ON DELETE RESTRICT,
  CONSTRAINT "IssueNote_account_fkey" FOREIGN KEY ("orgId", "authorAccountId") REFERENCES "LoginAccount"("orgId", "id") ON DELETE RESTRICT,
  CONSTRAINT "IssueNote_person_fkey" FOREIGN KEY ("orgId", "authorPersonId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT,
  CONSTRAINT "IssueNote_kind_check" CHECK ("kind" IN ('note', 'reply')),
  CONSTRAINT "IssueNote_text_check" CHECK (length(btrim("text")) BETWEEN 1 AND 2000)
);
CREATE INDEX "IssueNote_issue_idx" ON "IssueNote"("orgId", "issueId", "seq");

-- Effective-dated close/reopen history. "Issue".state/closedOn/closedBy only hold the current
-- state; the status as of a business day is the last transition dated on or before it.
-- Transitions are written under the issue row lock, so "seq" (not the clock, which can step
-- backwards) is the order in which they were applied, also within one business day.
CREATE TABLE "IssueTransition" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL REFERENCES "Organization"("id") ON DELETE RESTRICT,
  "issueId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "onDate" DATE NOT NULL,
  "actorAccountId" UUID NOT NULL,
  "actorPersonId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "seq" BIGINT GENERATED ALWAYS AS IDENTITY,
  CONSTRAINT "IssueTransition_orgId_id_key" UNIQUE ("orgId", "id"),
  CONSTRAINT "IssueTransition_issue_fkey" FOREIGN KEY ("orgId", "issueId") REFERENCES "Issue"("orgId", "id") ON DELETE RESTRICT,
  CONSTRAINT "IssueTransition_account_fkey" FOREIGN KEY ("orgId", "actorAccountId") REFERENCES "LoginAccount"("orgId", "id") ON DELETE RESTRICT,
  CONSTRAINT "IssueTransition_person_fkey" FOREIGN KEY ("orgId", "actorPersonId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT,
  CONSTRAINT "IssueTransition_kind_check" CHECK ("kind" IN ('close', 'reopen'))
);
CREATE INDEX "IssueTransition_issue_idx" ON "IssueTransition"("orgId", "issueId", "onDate", "seq");

CREATE TABLE "LagDismissal" (
  "id" UUID NOT NULL PRIMARY KEY,
  "orgId" UUID NOT NULL REFERENCES "Organization"("id") ON DELETE RESTRICT,
  "projectId" UUID NOT NULL,
  "businessDate" DATE NOT NULL,
  "workItemKey" TEXT NOT NULL,
  "dismissedBy" UUID NOT NULL,
  "dismissedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "LagDismissal_orgId_id_key" UNIQUE ("orgId", "id"),
  CONSTRAINT "LagDismissal_item_key" UNIQUE ("orgId", "projectId", "businessDate", "workItemKey"),
  CONSTRAINT "LagDismissal_project_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT,
  CONSTRAINT "LagDismissal_actor_fkey" FOREIGN KEY ("orgId", "dismissedBy") REFERENCES "LoginAccount"("orgId", "id") ON DELETE RESTRICT,
  CONSTRAINT "LagDismissal_workItemKey_check" CHECK ("workItemKey" ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$')
);

-- "Issue" had neither grants nor RLS for the application role before this migration.
GRANT SELECT, INSERT, UPDATE ON "Issue" TO mje_alpha_app;
GRANT SELECT, INSERT ON "IssueNote", "IssueTransition", "LagDismissal" TO mje_alpha_app;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['Issue', 'IssueNote', 'IssueTransition', 'LagDismissal'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY alpha_org ON %I TO mje_alpha_app USING ("orgId"::text = current_setting(''app.org_id'', true)) WITH CHECK ("orgId"::text = current_setting(''app.org_id'', true))', table_name);
  END LOOP;
END $$;
