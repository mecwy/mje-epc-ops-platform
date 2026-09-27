-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PricingType" AS ENUM ('UNKNOWN', 'LUMP_SUM', 'TIME_AND_MATERIAL', 'UNIT_PRICE', 'REIMBURSABLE');

-- CreateEnum
CREATE TYPE "PlanKind" AS ENUM ('QUOTE_ASSUMPTION', 'APPROVED_BASELINE', 'ROLLING_PLAN', 'CONTRACT_MINIMUM');

-- CreateEnum
CREATE TYPE "VerificationScope" AS ENUM ('IDENTITY', 'PRESENCE', 'LABOR', 'OUTPUT');

-- CreateEnum
CREATE TYPE "VerificationResult" AS ENUM ('NOT_CHECKED', 'CONFIRMED_AT_POINT', 'CONFIRMED_INTERVAL', 'CONTRADICTED', 'INCONCLUSIVE');

-- CreateEnum
CREATE TYPE "TimePrecision" AS ENUM ('INTERVAL', 'NET_MINUTES', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "LaborKind" AS ENUM ('DIRECT', 'SUPPORT', 'REWORK', 'WAITING', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DailyCloseState" AS ENUM ('EXPECTED', 'DRAFT', 'SUBMITTED', 'RETURNED', 'REVIEWED', 'CLOSED');

-- CreateEnum
CREATE TYPE "IssueState" AS ENUM ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLUTION_SUBMITTED', 'VERIFIED_CLOSED', 'REOPENED');

-- CreateEnum
CREATE TYPE "RevisionState" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "governanceRef" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "companyId" UUID,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "code" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "customerId" UUID,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "customerId" UUID,
    "opportunityId" UUID,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectSite" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "projectId" UUID NOT NULL,
    "siteId" UUID NOT NULL,

    CONSTRAINT "ProjectSite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Area" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "siteId" UUID NOT NULL,

    CONSTRAINT "Area_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractScope" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "code" TEXT NOT NULL,
    "pricingType" "PricingType" NOT NULL,
    "currency" CHAR(3),
    "amount" DECIMAL(20,4),
    "policyVersion" TEXT,
    "projectId" UUID NOT NULL,
    "vendorId" UUID,

    CONSTRAINT "ContractScope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkPackage" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "uom" TEXT,
    "designQuantity" DECIMAL(20,6),
    "baselineVersion" TEXT,
    "projectId" UUID NOT NULL,
    "areaId" UUID,
    "contractScopeId" UUID,

    CONSTRAINT "WorkPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Person" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "displayName" TEXT NOT NULL,
    "identityStatus" TEXT NOT NULL DEFAULT 'PROVISIONAL',
    "employerId" UUID,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginAccount" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "entraTenantId" TEXT NOT NULL,
    "entraObjectId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "personId" UUID,

    CONSTRAINT "LoginAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "role" TEXT NOT NULL,
    "activeFrom" TIMESTAMPTZ(6) NOT NULL,
    "activeUntil" TIMESTAMPTZ(6),
    "accountId" UUID NOT NULL,
    "projectId" UUID,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonAlias" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "value" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "verificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "personId" UUID NOT NULL,

    CONSTRAINT "PersonAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonAssignment" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "trade" TEXT,
    "crew" TEXT,
    "validFrom" TIMESTAMPTZ(6) NOT NULL,
    "validUntil" TIMESTAMPTZ(6),
    "personId" UUID NOT NULL,
    "projectId" UUID,
    "opportunityId" UUID,

    CONSTRAINT "PersonAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkforcePlan" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "kind" "PlanKind" NOT NULL,
    "businessDate" DATE NOT NULL,
    "plannedHeadcount" INTEGER,
    "plannedMinutes" INTEGER,
    "authorityStatus" TEXT NOT NULL DEFAULT 'NOT_PROVIDED',
    "planVersion" INTEGER NOT NULL,
    "policyRef" TEXT,
    "projectId" UUID NOT NULL,
    "workPackageId" UUID,

    CONSTRAINT "WorkforcePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceDocument" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "sha256" CHAR(64) NOT NULL,
    "filename" TEXT NOT NULL,
    "blobKey" TEXT NOT NULL,
    "reportedDate" DATE,
    "importedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawPreparerName" TEXT,
    "sourceVersion" TEXT NOT NULL,

    CONSTRAINT "SourceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceAssertion" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "locator" TEXT NOT NULL,
    "rawValue" JSONB NOT NULL,
    "rawUom" TEXT,
    "missingReason" TEXT,
    "sourceLayer" TEXT NOT NULL,
    "documentId" UUID NOT NULL,

    CONSTRAINT "SourceAssertion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportingBundle" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "businessDate" DATE NOT NULL,
    "rawTitle" TEXT NOT NULL,
    "assignmentStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "sourceDocumentId" UUID,
    "titleProjectCandidateId" UUID,

    CONSTRAINT "ReportingBundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceClaim" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "businessDate" DATE NOT NULL,
    "reportedTotal" INTEGER,
    "roleCounts" JSONB,
    "claimedStart" TIMESTAMPTZ(6),
    "claimedEnd" TIMESTAMPTZ(6),
    "sourceStatus" TEXT NOT NULL DEFAULT 'REPORTED',
    "bundleId" UUID NOT NULL,
    "personId" UUID,
    "sourceId" UUID,

    CONSTRAINT "AttendanceClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PresenceVerification" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "scope" "VerificationScope" NOT NULL,
    "result" "VerificationResult" NOT NULL,
    "observedAt" TIMESTAMPTZ(6),
    "intervalStart" TIMESTAMPTZ(6),
    "intervalEnd" TIMESTAMPTZ(6),
    "limitations" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "claimId" UUID NOT NULL,
    "reviewerPersonId" UUID NOT NULL,
    "subjectPersonId" UUID,

    CONSTRAINT "PresenceVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyTask" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "businessDate" DATE NOT NULL,
    "rawArea" TEXT,
    "activity" TEXT NOT NULL,
    "assignmentStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "bundleId" UUID NOT NULL,
    "projectId" UUID,
    "opportunityId" UUID,
    "areaId" UUID,
    "workPackageId" UUID,
    "sourceId" UUID,

    CONSTRAINT "DailyTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LaborEntry" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "businessDate" DATE NOT NULL,
    "siteTimezone" TEXT NOT NULL,
    "startAt" TIMESTAMPTZ(6),
    "endAt" TIMESTAMPTZ(6),
    "netMinutes" INTEGER,
    "precision" "TimePrecision" NOT NULL,
    "laborKind" "LaborKind" NOT NULL,
    "payTimeKind" TEXT NOT NULL,
    "acceptedLedger" BOOLEAN NOT NULL DEFAULT false,
    "personId" UUID NOT NULL,
    "claimId" UUID,
    "sourceId" UUID,

    CONSTRAINT "LaborEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LaborAllocation" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "allocatedMinutes" INTEGER NOT NULL,
    "allocationStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "laborEntryId" UUID NOT NULL,
    "taskId" UUID NOT NULL,

    CONSTRAINT "LaborAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyQuantityPlan" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "targetBusinessDate" DATE NOT NULL,
    "qty" DECIMAL(20,6),
    "uom" TEXT NOT NULL,
    "authorityStatus" TEXT NOT NULL DEFAULT 'NOT_PROVIDED',
    "sourceVersion" TEXT NOT NULL,
    "workPackageId" UUID,
    "sourceId" UUID NOT NULL,

    CONSTRAINT "DailyQuantityPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuantityProgress" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "businessDate" DATE NOT NULL,
    "reportedToday" DECIMAL(20,6),
    "reportedCumulative" DECIMAL(20,6),
    "rawUom" TEXT NOT NULL,
    "reportedPercent" TEXT,
    "denominatorQty" DECIMAL(20,6),
    "denominatorVersion" TEXT,
    "rawScope" TEXT NOT NULL,
    "scopeStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "outputStage" TEXT NOT NULL,
    "roundingPolicy" TEXT,
    "taskId" UUID NOT NULL,
    "sourceId" UUID,

    CONSTRAINT "QuantityProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inspection" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "inspectedAt" TIMESTAMPTZ(6) NOT NULL,
    "inspectedQty" DECIMAL(20,6) NOT NULL,
    "uom" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "progressId" UUID NOT NULL,
    "inspectorPersonId" UUID NOT NULL,

    CONSTRAINT "Inspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Acceptance" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "acceptedAt" TIMESTAMPTZ(6) NOT NULL,
    "acceptedQty" DECIMAL(20,6) NOT NULL,
    "uom" TEXT NOT NULL,
    "basisVersion" TEXT NOT NULL,
    "inspectionId" UUID NOT NULL,
    "approverPersonId" UUID NOT NULL,

    CONSTRAINT "Acceptance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhotoEvidence" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "sha256" CHAR(64) NOT NULL,
    "blobKey" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "deviceCapturedAt" TIMESTAMPTZ(6),
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "watermarkAssertion" JSONB,
    "assignmentStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "sourceDocumentId" UUID,

    CONSTRAINT "PhotoEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceLink" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "coverageDescription" TEXT NOT NULL,
    "photoId" UUID NOT NULL,
    "taskId" UUID,
    "verificationId" UUID,
    "inspectionId" UUID,

    CONSTRAINT "EvidenceLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Issue" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "kind" TEXT NOT NULL,
    "state" "IssueState" NOT NULL DEFAULT 'OPEN',
    "summary" TEXT NOT NULL,
    "dueAt" TIMESTAMPTZ(6),
    "resolution" TEXT,
    "projectId" UUID,
    "taskId" UUID,
    "sourceId" UUID,
    "ownerPersonId" UUID,

    CONSTRAINT "Issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyClose" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "businessDate" DATE NOT NULL,
    "siteTimezone" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "state" "DailyCloseState" NOT NULL DEFAULT 'EXPECTED',
    "expectedReason" TEXT NOT NULL,
    "expectedDueAt" TIMESTAMPTZ(6),
    "currentRevisionNumber" INTEGER NOT NULL DEFAULT 0,
    "projectId" UUID NOT NULL,
    "areaId" UUID,
    "responsiblePersonId" UUID,
    "delegatePersonId" UUID,

    CONSTRAINT "DailyClose_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Revision" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "revisionNumber" INTEGER NOT NULL,
    "baseRevisionNumber" INTEGER,
    "state" "RevisionState" NOT NULL DEFAULT 'DRAFT',
    "reason" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "submittedAt" TIMESTAMPTZ(6),
    "dailyCloseId" UUID NOT NULL,

    CONSTRAINT "Revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevisionEvent" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "actorPersonId" UUID NOT NULL,
    "revisionId" UUID NOT NULL,

    CONSTRAINT "RevisionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyFactLink" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "factType" TEXT NOT NULL,
    "factId" UUID NOT NULL,
    "factVersion" INTEGER NOT NULL,
    "revisionId" UUID NOT NULL,

    CONSTRAINT "DailyFactLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChargeableLaborReference" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "sourceVersion" INTEGER NOT NULL,
    "quantity" DECIMAL(20,6),
    "uom" TEXT,
    "rightStatus" TEXT NOT NULL DEFAULT 'UNASSESSED',
    "rate" DECIMAL(20,4),
    "currency" CHAR(3),
    "laborEntryId" UUID NOT NULL,
    "contractScopeId" UUID NOT NULL,

    CONSTRAINT "ChargeableLaborReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actorId" UUID NOT NULL,
    "route" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "status" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "expiresAt" TIMESTAMPTZ(6),

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "eventType" TEXT NOT NULL,
    "aggregateId" UUID NOT NULL,
    "aggregateVersion" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "availableAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "updatedBy" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actorAccountId" UUID,
    "actorPersonId" UUID,
    "actorKind" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "entityVersion" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "correlationId" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_orgId_id_key" ON "Company"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_orgId_id_key" ON "Customer"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Opportunity_orgId_id_key" ON "Opportunity"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Opportunity_orgId_code_key" ON "Opportunity"("orgId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Project_orgId_id_key" ON "Project"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Project_orgId_code_key" ON "Project"("orgId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Site_orgId_id_key" ON "Site"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Site_orgId_code_key" ON "Site"("orgId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSite_orgId_id_key" ON "ProjectSite"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSite_orgId_projectId_siteId_key" ON "ProjectSite"("orgId", "projectId", "siteId");

-- CreateIndex
CREATE UNIQUE INDEX "Area_orgId_id_key" ON "Area"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ContractScope_orgId_id_key" ON "ContractScope"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkPackage_orgId_id_key" ON "WorkPackage"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Person_orgId_id_key" ON "Person"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LoginAccount_orgId_id_key" ON "LoginAccount"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LoginAccount_orgId_entraTenantId_entraObjectId_key" ON "LoginAccount"("orgId", "entraTenantId", "entraObjectId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_orgId_id_key" ON "Membership"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PersonAlias_orgId_id_key" ON "PersonAlias"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PersonAssignment_orgId_id_key" ON "PersonAssignment"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforcePlan_orgId_id_key" ON "WorkforcePlan"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SourceDocument_orgId_id_key" ON "SourceDocument"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SourceDocument_orgId_sha256_key" ON "SourceDocument"("orgId", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "SourceAssertion_orgId_id_key" ON "SourceAssertion"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SourceAssertion_orgId_documentId_locator_key" ON "SourceAssertion"("orgId", "documentId", "locator");

-- CreateIndex
CREATE UNIQUE INDEX "ReportingBundle_orgId_id_key" ON "ReportingBundle"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceClaim_orgId_id_key" ON "AttendanceClaim"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PresenceVerification_orgId_id_key" ON "PresenceVerification"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DailyTask_orgId_id_key" ON "DailyTask"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LaborEntry_orgId_id_key" ON "LaborEntry"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LaborAllocation_orgId_id_key" ON "LaborAllocation"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DailyQuantityPlan_orgId_id_key" ON "DailyQuantityPlan"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "QuantityProgress_orgId_id_key" ON "QuantityProgress"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Inspection_orgId_id_key" ON "Inspection"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Acceptance_orgId_id_key" ON "Acceptance"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PhotoEvidence_orgId_id_key" ON "PhotoEvidence"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PhotoEvidence_orgId_sha256_key" ON "PhotoEvidence"("orgId", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceLink_orgId_id_key" ON "EvidenceLink"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Issue_orgId_id_key" ON "Issue"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DailyClose_orgId_id_key" ON "DailyClose"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DailyClose_orgId_projectId_businessDate_scopeKey_key" ON "DailyClose"("orgId", "projectId", "businessDate", "scopeKey");

-- CreateIndex
CREATE UNIQUE INDEX "Revision_orgId_id_key" ON "Revision"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Revision_orgId_dailyCloseId_revisionNumber_key" ON "Revision"("orgId", "dailyCloseId", "revisionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "RevisionEvent_orgId_id_key" ON "RevisionEvent"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DailyFactLink_orgId_id_key" ON "DailyFactLink"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DailyFactLink_orgId_revisionId_factType_factId_factVersion_key" ON "DailyFactLink"("orgId", "revisionId", "factType", "factId", "factVersion");

-- CreateIndex
CREATE UNIQUE INDEX "ChargeableLaborReference_orgId_id_key" ON "ChargeableLaborReference"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_orgId_id_key" ON "IdempotencyRecord"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_orgId_actorId_route_key_key" ON "IdempotencyRecord"("orgId", "actorId", "route", "key");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_orgId_id_key" ON "OutboxEvent"("orgId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_orgId_eventType_aggregateId_aggregateVersion_key" ON "OutboxEvent"("orgId", "eventType", "aggregateId", "aggregateVersion");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_orgId_id_key" ON "AuditLog"("orgId", "id");

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_orgId_companyId_fkey" FOREIGN KEY ("orgId", "companyId") REFERENCES "Company"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_orgId_customerId_fkey" FOREIGN KEY ("orgId", "customerId") REFERENCES "Customer"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_orgId_customerId_fkey" FOREIGN KEY ("orgId", "customerId") REFERENCES "Customer"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_orgId_opportunityId_fkey" FOREIGN KEY ("orgId", "opportunityId") REFERENCES "Opportunity"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSite" ADD CONSTRAINT "ProjectSite_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSite" ADD CONSTRAINT "ProjectSite_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ProjectSite" ADD CONSTRAINT "ProjectSite_orgId_siteId_fkey" FOREIGN KEY ("orgId", "siteId") REFERENCES "Site"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Area" ADD CONSTRAINT "Area_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Area" ADD CONSTRAINT "Area_orgId_siteId_fkey" FOREIGN KEY ("orgId", "siteId") REFERENCES "Site"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ContractScope" ADD CONSTRAINT "ContractScope_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractScope" ADD CONSTRAINT "ContractScope_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ContractScope" ADD CONSTRAINT "ContractScope_orgId_vendorId_fkey" FOREIGN KEY ("orgId", "vendorId") REFERENCES "Company"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "WorkPackage" ADD CONSTRAINT "WorkPackage_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkPackage" ADD CONSTRAINT "WorkPackage_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "WorkPackage" ADD CONSTRAINT "WorkPackage_orgId_areaId_fkey" FOREIGN KEY ("orgId", "areaId") REFERENCES "Area"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "WorkPackage" ADD CONSTRAINT "WorkPackage_orgId_contractScopeId_fkey" FOREIGN KEY ("orgId", "contractScopeId") REFERENCES "ContractScope"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Person" ADD CONSTRAINT "Person_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Person" ADD CONSTRAINT "Person_orgId_employerId_fkey" FOREIGN KEY ("orgId", "employerId") REFERENCES "Company"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "LoginAccount" ADD CONSTRAINT "LoginAccount_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoginAccount" ADD CONSTRAINT "LoginAccount_orgId_personId_fkey" FOREIGN KEY ("orgId", "personId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_orgId_accountId_fkey" FOREIGN KEY ("orgId", "accountId") REFERENCES "LoginAccount"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PersonAlias" ADD CONSTRAINT "PersonAlias_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonAlias" ADD CONSTRAINT "PersonAlias_orgId_personId_fkey" FOREIGN KEY ("orgId", "personId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PersonAssignment" ADD CONSTRAINT "PersonAssignment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonAssignment" ADD CONSTRAINT "PersonAssignment_orgId_personId_fkey" FOREIGN KEY ("orgId", "personId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PersonAssignment" ADD CONSTRAINT "PersonAssignment_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PersonAssignment" ADD CONSTRAINT "PersonAssignment_orgId_opportunityId_fkey" FOREIGN KEY ("orgId", "opportunityId") REFERENCES "Opportunity"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "WorkforcePlan" ADD CONSTRAINT "WorkforcePlan_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforcePlan" ADD CONSTRAINT "WorkforcePlan_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "WorkforcePlan" ADD CONSTRAINT "WorkforcePlan_orgId_workPackageId_fkey" FOREIGN KEY ("orgId", "workPackageId") REFERENCES "WorkPackage"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SourceDocument" ADD CONSTRAINT "SourceDocument_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceAssertion" ADD CONSTRAINT "SourceAssertion_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceAssertion" ADD CONSTRAINT "SourceAssertion_orgId_documentId_fkey" FOREIGN KEY ("orgId", "documentId") REFERENCES "SourceDocument"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ReportingBundle" ADD CONSTRAINT "ReportingBundle_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportingBundle" ADD CONSTRAINT "ReportingBundle_orgId_sourceDocumentId_fkey" FOREIGN KEY ("orgId", "sourceDocumentId") REFERENCES "SourceDocument"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ReportingBundle" ADD CONSTRAINT "ReportingBundle_orgId_titleProjectCandidateId_fkey" FOREIGN KEY ("orgId", "titleProjectCandidateId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AttendanceClaim" ADD CONSTRAINT "AttendanceClaim_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceClaim" ADD CONSTRAINT "AttendanceClaim_orgId_bundleId_fkey" FOREIGN KEY ("orgId", "bundleId") REFERENCES "ReportingBundle"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AttendanceClaim" ADD CONSTRAINT "AttendanceClaim_orgId_personId_fkey" FOREIGN KEY ("orgId", "personId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AttendanceClaim" ADD CONSTRAINT "AttendanceClaim_orgId_sourceId_fkey" FOREIGN KEY ("orgId", "sourceId") REFERENCES "SourceAssertion"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PresenceVerification" ADD CONSTRAINT "PresenceVerification_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PresenceVerification" ADD CONSTRAINT "PresenceVerification_orgId_claimId_fkey" FOREIGN KEY ("orgId", "claimId") REFERENCES "AttendanceClaim"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PresenceVerification" ADD CONSTRAINT "PresenceVerification_orgId_reviewerPersonId_fkey" FOREIGN KEY ("orgId", "reviewerPersonId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PresenceVerification" ADD CONSTRAINT "PresenceVerification_orgId_subjectPersonId_fkey" FOREIGN KEY ("orgId", "subjectPersonId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DailyTask" ADD CONSTRAINT "DailyTask_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyTask" ADD CONSTRAINT "DailyTask_orgId_bundleId_fkey" FOREIGN KEY ("orgId", "bundleId") REFERENCES "ReportingBundle"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DailyTask" ADD CONSTRAINT "DailyTask_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DailyTask" ADD CONSTRAINT "DailyTask_orgId_opportunityId_fkey" FOREIGN KEY ("orgId", "opportunityId") REFERENCES "Opportunity"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DailyTask" ADD CONSTRAINT "DailyTask_orgId_areaId_fkey" FOREIGN KEY ("orgId", "areaId") REFERENCES "Area"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DailyTask" ADD CONSTRAINT "DailyTask_orgId_workPackageId_fkey" FOREIGN KEY ("orgId", "workPackageId") REFERENCES "WorkPackage"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DailyTask" ADD CONSTRAINT "DailyTask_orgId_sourceId_fkey" FOREIGN KEY ("orgId", "sourceId") REFERENCES "SourceAssertion"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "LaborEntry" ADD CONSTRAINT "LaborEntry_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LaborEntry" ADD CONSTRAINT "LaborEntry_orgId_personId_fkey" FOREIGN KEY ("orgId", "personId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "LaborEntry" ADD CONSTRAINT "LaborEntry_orgId_claimId_fkey" FOREIGN KEY ("orgId", "claimId") REFERENCES "AttendanceClaim"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "LaborEntry" ADD CONSTRAINT "LaborEntry_orgId_sourceId_fkey" FOREIGN KEY ("orgId", "sourceId") REFERENCES "SourceAssertion"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "LaborAllocation" ADD CONSTRAINT "LaborAllocation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LaborAllocation" ADD CONSTRAINT "LaborAllocation_orgId_laborEntryId_fkey" FOREIGN KEY ("orgId", "laborEntryId") REFERENCES "LaborEntry"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "LaborAllocation" ADD CONSTRAINT "LaborAllocation_orgId_taskId_fkey" FOREIGN KEY ("orgId", "taskId") REFERENCES "DailyTask"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DailyQuantityPlan" ADD CONSTRAINT "DailyQuantityPlan_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyQuantityPlan" ADD CONSTRAINT "DailyQuantityPlan_orgId_workPackageId_fkey" FOREIGN KEY ("orgId", "workPackageId") REFERENCES "WorkPackage"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DailyQuantityPlan" ADD CONSTRAINT "DailyQuantityPlan_orgId_sourceId_fkey" FOREIGN KEY ("orgId", "sourceId") REFERENCES "SourceAssertion"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "QuantityProgress" ADD CONSTRAINT "QuantityProgress_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuantityProgress" ADD CONSTRAINT "QuantityProgress_orgId_taskId_fkey" FOREIGN KEY ("orgId", "taskId") REFERENCES "DailyTask"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "QuantityProgress" ADD CONSTRAINT "QuantityProgress_orgId_sourceId_fkey" FOREIGN KEY ("orgId", "sourceId") REFERENCES "SourceAssertion"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_orgId_progressId_fkey" FOREIGN KEY ("orgId", "progressId") REFERENCES "QuantityProgress"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_orgId_inspectorPersonId_fkey" FOREIGN KEY ("orgId", "inspectorPersonId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Acceptance" ADD CONSTRAINT "Acceptance_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Acceptance" ADD CONSTRAINT "Acceptance_orgId_inspectionId_fkey" FOREIGN KEY ("orgId", "inspectionId") REFERENCES "Inspection"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Acceptance" ADD CONSTRAINT "Acceptance_orgId_approverPersonId_fkey" FOREIGN KEY ("orgId", "approverPersonId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PhotoEvidence" ADD CONSTRAINT "PhotoEvidence_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhotoEvidence" ADD CONSTRAINT "PhotoEvidence_orgId_sourceDocumentId_fkey" FOREIGN KEY ("orgId", "sourceDocumentId") REFERENCES "SourceDocument"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EvidenceLink" ADD CONSTRAINT "EvidenceLink_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceLink" ADD CONSTRAINT "EvidenceLink_orgId_photoId_fkey" FOREIGN KEY ("orgId", "photoId") REFERENCES "PhotoEvidence"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EvidenceLink" ADD CONSTRAINT "EvidenceLink_orgId_taskId_fkey" FOREIGN KEY ("orgId", "taskId") REFERENCES "DailyTask"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EvidenceLink" ADD CONSTRAINT "EvidenceLink_orgId_verificationId_fkey" FOREIGN KEY ("orgId", "verificationId") REFERENCES "PresenceVerification"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EvidenceLink" ADD CONSTRAINT "EvidenceLink_orgId_inspectionId_fkey" FOREIGN KEY ("orgId", "inspectionId") REFERENCES "Inspection"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_orgId_taskId_fkey" FOREIGN KEY ("orgId", "taskId") REFERENCES "DailyTask"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_orgId_sourceId_fkey" FOREIGN KEY ("orgId", "sourceId") REFERENCES "SourceAssertion"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_orgId_ownerPersonId_fkey" FOREIGN KEY ("orgId", "ownerPersonId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DailyClose" ADD CONSTRAINT "DailyClose_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyClose" ADD CONSTRAINT "DailyClose_orgId_projectId_fkey" FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DailyClose" ADD CONSTRAINT "DailyClose_orgId_areaId_fkey" FOREIGN KEY ("orgId", "areaId") REFERENCES "Area"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DailyClose" ADD CONSTRAINT "DailyClose_orgId_responsiblePersonId_fkey" FOREIGN KEY ("orgId", "responsiblePersonId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DailyClose" ADD CONSTRAINT "DailyClose_orgId_delegatePersonId_fkey" FOREIGN KEY ("orgId", "delegatePersonId") REFERENCES "Person"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Revision" ADD CONSTRAINT "Revision_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Revision" ADD CONSTRAINT "Revision_orgId_dailyCloseId_fkey" FOREIGN KEY ("orgId", "dailyCloseId") REFERENCES "DailyClose"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "RevisionEvent" ADD CONSTRAINT "RevisionEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevisionEvent" ADD CONSTRAINT "RevisionEvent_orgId_revisionId_fkey" FOREIGN KEY ("orgId", "revisionId") REFERENCES "Revision"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DailyFactLink" ADD CONSTRAINT "DailyFactLink_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyFactLink" ADD CONSTRAINT "DailyFactLink_orgId_revisionId_fkey" FOREIGN KEY ("orgId", "revisionId") REFERENCES "Revision"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ChargeableLaborReference" ADD CONSTRAINT "ChargeableLaborReference_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChargeableLaborReference" ADD CONSTRAINT "ChargeableLaborReference_orgId_laborEntryId_fkey" FOREIGN KEY ("orgId", "laborEntryId") REFERENCES "LaborEntry"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ChargeableLaborReference" ADD CONSTRAINT "ChargeableLaborReference_orgId_contractScopeId_fkey" FOREIGN KEY ("orgId", "contractScopeId") REFERENCES "ContractScope"("orgId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Phase 0 database guard prototypes. Runtime authorization is NOT implemented.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "LaborEntry" ADD CONSTRAINT labor_time_valid CHECK (
  ("netMinutes" IS NULL OR "netMinutes" >= 0) AND
  ("startAt" IS NULL OR "endAt" IS NULL OR "endAt" > "startAt") AND
  (NOT "acceptedLedger" OR (precision = 'INTERVAL' AND "startAt" IS NOT NULL AND "endAt" IS NOT NULL AND "netMinutes" IS NOT NULL))
);
ALTER TABLE "LaborEntry" ADD CONSTRAINT no_canonical_person_overlap
  EXCLUDE USING gist ("orgId" WITH =, "personId" WITH =, tstzrange("startAt", "endAt", '[)') WITH &&)
  WHERE ("acceptedLedger");
CREATE FUNCTION deny_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append-only source or audit record'; END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION deny_change();
CREATE TRIGGER source_document_immutable BEFORE UPDATE OR DELETE ON "SourceDocument" FOR EACH ROW EXECUTE FUNCTION deny_change();
CREATE TRIGGER source_assertion_immutable BEFORE UPDATE OR DELETE ON "SourceAssertion" FOR EACH ROW EXECUTE FUNCTION deny_change();
CREATE FUNCTION protect_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state <> 'DRAFT' THEN RAISE EXCEPTION 'submitted revision is immutable; append a RevisionEvent or new Revision'; END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER revision_immutable BEFORE UPDATE OR DELETE ON "Revision" FOR EACH ROW EXECUTE FUNCTION protect_revision();
CREATE TRIGGER revision_event_append_only BEFORE UPDATE OR DELETE ON "RevisionEvent" FOR EACH ROW EXECUTE FUNCTION deny_change();
