/**
 * ADR-0003 D2.1: module ownership of tables and the registered legacy cross-module SQL. A table
 * of another module in a module's SQL text fails `sql-scan.test.ts` unless listed here; a listed
 * entry that no longer occurs fails too (remove it with the code). Each entry names the exit
 * that replaces it and the slice that removes it. Pure data.
 */

export type ModuleName =
  'platform' | 'alpha' | 'report' | 'issue' | 'photo' | 'field';

export interface ModuleSpec {
  /** Files under packages/domain/src (non-test) that belong to the module. */
  files: string[];
  /** Tables the module owns (Prisma model names). */
  tables: string[];
}

/**
 * Identity and tenancy kernel: read by every module through store-kit and the stores
 * (organisation, account, person, membership, project, idempotency and audit). Not business
 * data of any module, so not subject to the cross-module rule.
 */
export const SHARED_TABLES = [
  'Organization',
  'LoginAccount',
  'Person',
  'Membership',
  'Project',
  'IdempotencyRecord',
  'AuditLog',
] as const;

export const MODULES: Record<ModuleName, ModuleSpec> = {
  platform: { files: ['store-kit.ts', 'image-bytes.ts'], tables: [] },
  alpha: { files: ['alpha-store.ts'], tables: ['AlphaDraft'] },
  report: {
    files: [
      'report-store.ts',
      'report-reader.ts',
      'report-read-context.ts',
      'report-rules.ts',
      'reader-view.ts',
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
    files: ['issue-store.ts'],
    tables: ['Issue', 'IssueNote', 'IssueTransition', 'LagDismissal'],
  },
  photo: {
    files: ['photo-store.ts', 'photo-file.ts', 'photo-strip.ts'],
    tables: ['PhotoEvidence', 'EvidenceLink'],
  },
  /** A6 field module: roster, devices, check-ins and foreman reports. */
  field: {
    files: [
      'field-store.ts',
      'field-kit.ts',
      'field-roster.ts',
      'field-rules.ts',
      'checkin-store.ts',
      'checkin-rules.ts',
      'foreman-store.ts',
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
};

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

const MOVE =
  'A7-0 module move of report/, issue/, photo/ (ADR-0003 D2.1; slice id to be assigned)';
const FIELD_EXIT =
  'field module exit (A6 stores keep their exports, ADR-0003 §4; slice id to be assigned)';

export const LEGACY_ADAPTERS: readonly LegacyAdapter[] = [
  {
    file: 'issue-store.ts',
    site: 'IssueStore.assertWorkItem',
    table: 'ReportItem',
    access: 'read',
    why: 'an issue may name an active work item of its project',
    replacement: 'reportReader work-item lookup (master data)',
    removal: MOVE,
  },
  {
    file: 'photo-store.ts',
    site: 'latestFrozen / isFrozen / latestFrozenAs / upload',
    table: 'DailyClose',
    access: 'read',
    why: 'which photos a submission froze; whether a day is open for upload',
    replacement: 'reportReader frozen-photo and day-state lookups',
    removal: MOVE,
  },
  {
    file: 'photo-store.ts',
    site: 'latestFrozen / isFrozen / latestFrozenAs',
    table: 'Revision',
    access: 'read',
    why: 'the photos frozen in the latest submitted revision',
    replacement: 'reportReader frozen-photo lookup',
    removal: MOVE,
  },
  {
    file: 'photo-store.ts',
    site: 'PhotoStore.assertTarget',
    table: 'Issue',
    access: 'read',
    why: 'a photo may be linked to an issue of its project',
    replacement: 'issueReader target lookup',
    removal: MOVE,
  },
  {
    file: 'photo-store.ts',
    site: 'activeWorkItems / PhotoStore.assertTarget',
    table: 'ReportItem',
    access: 'read',
    why: 'a photo may be linked to an active work item',
    replacement: 'reportReader work-item lookup (master data)',
    removal: MOVE,
  },
  {
    file: 'checkin-store.ts',
    site: 'submittedBoundary',
    table: 'DailyClose',
    access: 'read',
    why: 'the field sequence boundary frozen by the latest submission',
    replacement: 'reportReader submitted-boundary lookup',
    removal: FIELD_EXIT,
  },
  {
    file: 'checkin-store.ts',
    site: 'submittedBoundary',
    table: 'Revision',
    access: 'read',
    why: 'the field sequence boundary frozen by the latest submission',
    replacement: 'reportReader submitted-boundary lookup',
    removal: FIELD_EXIT,
  },
  {
    file: 'foreman-store.ts',
    site: 'ForemanStore.workItems',
    table: 'ReportItem',
    access: 'read',
    why: 'the active work items a foreman may report',
    replacement: 'reportReader work-item lookup (master data)',
    removal: FIELD_EXIT,
  },
  {
    file: 'report-store.ts',
    site: 'ReportStore.adoptForeman',
    table: 'ForemanAdoption',
    access: 'write',
    why: 'adopting a foreman total records the adoption beside the facts (A6c)',
    replacement: 'field module command (foreman adoption record)',
    removal: FIELD_EXIT,
  },
  ...(['DailyClose', 'Revision', 'RevisionEvent'] as const).map(
    (table): LegacyAdapter => ({
      file: 'alpha-store.ts',
      site: 'AlphaStore (list / get / save)',
      table,
      access: 'write',
      why: 'the Alpha site-day slice stores its days in the report day tables under its own scopeKey',
      replacement:
        'none planned: retire the Alpha slice or give it its own tables',
      removal: 'Alpha slice retirement (not scheduled; open question)',
    }),
  ),
];
