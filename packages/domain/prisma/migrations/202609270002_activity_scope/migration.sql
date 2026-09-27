-- Preserve existing applied migration; extend vocabulary from MW-007 / MW-014.
ALTER TYPE "PlanKind" ADD VALUE 'RECOVERY_PLAN';
ALTER TYPE "LaborKind" ADD VALUE 'OFFSITE';
ALTER TYPE "LaborKind" ADD VALUE 'TRAVEL';
ALTER TYPE "LaborKind" ADD VALUE 'BREAK';
ALTER TYPE "LaborKind" ADD VALUE 'UNALLOCATED';
