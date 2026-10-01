/**
 * ADR-0003 D2.1: module ownership of tables and the registered legacy cross-module SQL. A table
 * of another module in a module's SQL text fails `sql-scan.test.ts` unless listed here; a listed
 * entry that no longer occurs fails too (remove it with the code). Each entry names the exit
 * that replaces it and the slice that removes it. Pure data.
 */

export type ModuleName =
  | 'platform'
  | 'authz'
  | 'alpha'
  | 'report'
  | 'issue'
  | 'photo'
  | 'field'
  | 'apps';

export interface ModuleSpec {
  /** Repository-relative source files (non-test) that belong to the module. */
  files: string[];
  /** Repository-relative directories whose every (non-test) source belongs to the module. */
  dirs?: string[];
  /** Tables the module owns (Prisma model names). */
  tables: string[];
}

const D = 'packages/domain/src/';
export const MODULES: Record<ModuleName, ModuleSpec> = {
  /** Identity, tenancy, idempotency and audit plumbing (store-kit) and the package barrel. */
  platform: {
    files: [`${D}store-kit.ts`, `${D}image-bytes.ts`, `${D}index.ts`],
    tables: [
      'Organization',
      'LoginAccount',
      'Person',
      'Membership',
      'Project',
      'IdempotencyRecord',
      'AuditLog',
    ],
  },
  /** The rule model (no SQL). */
  authz: { files: [], dirs: [`${D}authz/`], tables: [] },
  alpha: { files: [`${D}alpha-store.ts`], tables: ['AlphaDraft'] },
  report: {
    files: [
      `${D}report-store.ts`,
      `${D}report-reader.ts`,
      `${D}report-read-context.ts`,
      `${D}report-commands.ts`,
      `${D}report-rules.ts`,
      `${D}reader-view.ts`,
    ],
    tables: [
      'DailyClose',
      'DailyReportDraft',
      'Revision',
      'RevisionEvent',
      'PlanDraft',
      'PlanVersion',
      'ReportItem',
    ],
  },
  issue: {
    files: [`${D}issue-store.ts`],
    tables: ['Issue', 'IssueNote', 'IssueTransition', 'LagDismissal'],
  },
  photo: {
    files: [`${D}photo-store.ts`, `${D}photo-file.ts`, `${D}photo-strip.ts`],
    tables: ['PhotoEvidence', 'EvidenceLink'],
  },
  /** A6 field module: roster, devices, check-ins and foreman reports. */
  field: {
    files: [
      `${D}field-store.ts`,
      `${D}field-kit.ts`,
      `${D}field-roster.ts`,
      `${D}field-rules.ts`,
      `${D}checkin-store.ts`,
      `${D}checkin-rules.ts`,
      `${D}foreman-store.ts`,
    ],
    tables: [
      'Crew',
      'CrewAssignment',
      'FieldConfirmChallenge',
      'FieldDevice',
      'FieldDeviceEvent',
      'FieldEntryCode',
      'FieldPersonConfirm',
      'FieldTokenHash',
      'FieldThrottle',
      'FieldThrottleSalt',
      'ProjectRoster',
      'ProjectFieldSetting',
      'ProjectSiteReference',
      'FieldDay',
      'FieldSelfie',
      'CheckInSelfie',
      'WorkerCheckIn',
      'ForemanReport',
      'ForemanReportRevision',
      'ForemanAdoption',
    ],
  },
  /** HTTP and process entries: no SQL of their own. */
  apps: { files: [], dirs: ['apps/api/src/', 'apps/worker/src/'], tables: [] },
};

export type SqlOperation = 'read' | 'write';
/**
 * Platform tables used outside store-kit, per file, table and operation, as they exist today.
 * Not a blanket exemption: any other use fails the scan, and an entry no longer used fails too.
 * Identity, tenancy, idempotency and audit belong behind store-kit / field-kit; the direct uses
 * below are the current exceptions.
 */
export const KERNEL_USES: readonly {
  file: string;
  table: string;
  op: SqlOperation;
}[] = [
  // Alpha slice: its own copy of the idempotency and audit plumbing; since A7-0b its account
  // transaction is store-kit's (ADR-0003 D5), so it no longer reads LoginAccount itself.
  { file: `${D}alpha-store.ts`, table: 'Membership', op: 'read' },
  { file: `${D}alpha-store.ts`, table: 'Project', op: 'read' },
  { file: `${D}alpha-store.ts`, table: 'IdempotencyRecord', op: 'read' },
  { file: `${D}alpha-store.ts`, table: 'IdempotencyRecord', op: 'write' },
  { file: `${D}alpha-store.ts`, table: 'AuditLog', op: 'write' },
  // Field kit: device idempotency (keyed by device, not account).
  { file: `${D}field-kit.ts`, table: 'IdempotencyRecord', op: 'read' },
  { file: `${D}field-kit.ts`, table: 'IdempotencyRecord', op: 'write' },
  // Check-in audit rows carry the device actor, which store-kit audit() cannot express.
  { file: `${D}checkin-store.ts`, table: 'AuditLog', op: 'write' },
  // Project and person reads, per module.
  { file: `${D}report-reader.ts`, table: 'Project', op: 'read' },
  { file: `${D}report-reader.ts`, table: 'Membership', op: 'read' },
  { file: `${D}checkin-store.ts`, table: 'Project', op: 'read' },
  { file: `${D}checkin-store.ts`, table: 'Person', op: 'read' },
  { file: `${D}field-store.ts`, table: 'Project', op: 'read' },
  { file: `${D}field-store.ts`, table: 'Person', op: 'read' },
  { file: `${D}field-roster.ts`, table: 'Person', op: 'read' },
  { file: `${D}foreman-store.ts`, table: 'Project', op: 'read' },
];

export interface LegacyAdapter {
  /** File under packages/domain/src. */
  file: string;
  /** Function or method that holds the SQL. */
  site: string;
  table: string;
  access: 'read' | 'write';
  why: string;
  /** The module exit that replaces the direct SQL. */
  replacement: string;
  /** The slice that removes the entry. */
  removal: string;
}

/** Remaining cross-module reads: replaced by module exits (PM: A7-0e). */
const READS = 'A7-0e';

export const LEGACY_ADAPTERS: readonly LegacyAdapter[] = [
  {
    file: `${D}issue-store.ts`,
    site: 'IssueStore.assertWorkItem',
    table: 'ReportItem',
    access: 'read',
    why: 'an issue may name an active work item of its project',
    replacement: 'reportReader work-item lookup (master data)',
    removal: READS,
  },
  {
    file: `${D}photo-store.ts`,
    site: 'latestFrozen / isFrozen / latestFrozenAs / upload',
    table: 'DailyClose',
    access: 'read',
    why: 'which photos a submission froze; whether a day is open for upload',
    replacement: 'reportReader frozen-photo and day-state lookups',
    removal: READS,
  },
  {
    file: `${D}photo-store.ts`,
    site: 'latestFrozen / isFrozen / latestFrozenAs',
    table: 'Revision',
    access: 'read',
    why: 'the photos frozen in the latest submitted revision',
    replacement: 'reportReader frozen-photo lookup',
    removal: READS,
  },
  {
    file: `${D}photo-store.ts`,
    site: 'PhotoStore.assertTarget',
    table: 'Issue',
    access: 'read',
    why: 'a photo may be linked to an issue of its project',
    replacement: 'issueReader target lookup',
    removal: READS,
  },
  {
    file: `${D}photo-store.ts`,
    site: 'activeWorkItems / PhotoStore.assertTarget',
    table: 'ReportItem',
    access: 'read',
    why: 'a photo may be linked to an active work item',
    replacement: 'reportReader work-item lookup (master data)',
    removal: READS,
  },
  {
    file: `${D}checkin-store.ts`,
    site: 'submittedBoundary',
    table: 'DailyClose',
    access: 'read',
    why: 'the field sequence boundary frozen by the latest submission',
    replacement: 'reportReader submitted-boundary lookup',
    removal: READS,
  },
  {
    file: `${D}checkin-store.ts`,
    site: 'submittedBoundary',
    table: 'Revision',
    access: 'read',
    why: 'the field sequence boundary frozen by the latest submission',
    replacement: 'reportReader submitted-boundary lookup',
    removal: READS,
  },
  {
    file: `${D}foreman-store.ts`,
    site: 'ForemanStore.workItems',
    table: 'ReportItem',
    access: 'read',
    why: 'the active work items a foreman may report',
    replacement: 'reportReader work-item lookup (master data)',
    removal: READS,
  },
  ...(['DailyClose', 'Revision'] as const).map((table): LegacyAdapter => ({
    file: `${D}alpha-store.ts`,
    site: 'AlphaStore (list / get / record / save)',
    table,
    access: 'read',
    why: 'the Alpha site-day slice reads its days from the report day tables under its own scopeKey; its writes go through the report command exit (A7-0d)',
    replacement: 'reportReader day lookup, or retire the Alpha slice',
    removal: READS,
  })),
];
