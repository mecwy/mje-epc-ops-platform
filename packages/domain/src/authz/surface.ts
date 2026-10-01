/**
 * ADR-0003 D2.2 / D4 / D6: every HTTP route and every Worker / CLI entry, with what it reads or
 * writes and for whom. Pure data; nothing here is consulted by production authorization (the
 * stores and the report exit enforce the rules). Mechanical checks keep it complete:
 * apps/api/src/authz-surface.test.ts fails on a registered route missing here or an entry here
 * without a route; the Worker / CLI scan does the same for entry files.
 *
 * Capabilities are the closed transition table of ADR-0003 D1 (role = implicit grant, equal to
 * today's behaviour). Entries outside that table (health, sign-in configuration, the Alpha
 * site-day slice, the device enrolment flow and system jobs) are marked `outsideD1: true` and
 * named in their own namespaces; they add no access.
 */
import type { Layer, ProjectorName } from './fields.js';

/** ADR-0003 D1 transition table (report / issue / photo / field / device), plus outside-D1 names. */
export type Capability =
  | 'report.view'
  | 'report.view-submitted'
  | 'report.write'
  | 'issue.view'
  | 'issue.write'
  | 'issue.reply'
  | 'photo.view'
  | 'photo.view-frozen'
  | 'photo.write'
  | 'field.admin.view'
  | 'field.admin.write'
  | 'field.device.session'
  | 'field.device.checkin'
  | 'field.device.selfie'
  | 'field.device.foreman'
  // outside D1 (see header)
  | 'field.device.enroll'
  | 'alpha.view'
  | 'alpha.write'
  | 'public'
  | 'system.boot'
  | 'system.selfie-cleanup';
/** Who can hold the capability: an Entra account, a field device token, nobody, or the platform. */
export type Principal = 'account' | 'fieldDevice' | 'none' | 'system';
export type Temporal = 'live' | 'submitted' | 'frozen';
/** ADR-0003 D4; `read` for read entries. */
export type Concurrency =
  'read' | 'cas' | 'append' | 'create' | 'legacy-overwrite';
export type ScopeSource =
  | 'none'
  | 'membership'
  | 'query.projectId'
  | 'body.projectId'
  | 'body.issueId'
  | 'path.issueId'
  | 'path.photoId'
  | 'body.photoId'
  | 'query.recordId'
  | 'path.recordId'
  | 'body.code'
  | 'device'
  | 'cli.orgId';
export type Discloses =
  'none' | { kind: 'existence'; code: string; basis: string };

export interface SurfaceEntry {
  /** `GET /path` as Express registers it, or `worker:<file>` / `cli:<file>`. */
  entry: string;
  kind: 'read' | 'write';
  principal: Principal;
  /** Any one of these allows the entry; listed strongest first. */
  capability: Capability[];
  scopeSource: ScopeSource;
  /** No module has a direction dimension yet (ADR-0003 D6; deferred.ts). */
  direction: 'n/a';
  /** Per held capability: which facts in time the response may contain. */
  temporal: Partial<Record<Capability, Temporal>>;
  /** Per held capability: the field layers (fields.ts) the response may contain. */
  layers: Partial<Record<Capability, Layer[]>>;
  /** Read entries: per held capability, the projector that shapes the response (fields.ts). */
  projector?: Partial<Record<Capability, ProjectorName>>;
  /** Write entries: the store command that executes it. */
  command?: string;
  concurrency: Concurrency;
  /** cas entries: the versions the base protects. */
  protects?: string[];
  /** Versions this entry advances (ADR-0003 D4/D7). */
  advances: string[];
  discloses: Discloses;
  outsideD1?: true;
}

const ALL: Layer[] = [
  'structure',
  'draft',
  'submitted',
  'coordinates',
  'public-text',
  'field-writer',
];
/** A read-only account on report data (OD18, OD20). */
const SUBMITTED: Layer[] = ['structure', 'submitted', 'public-text'];
const STRUCTURE: Layer[] = ['structure'];
const ISSUE: Layer[] = ['structure', 'public-text'];
const PHOTO_LIVE: Layer[] = ['structure', 'draft', 'submitted', 'coordinates'];
const PHOTO_FROZEN: Layer[] = ['structure', 'submitted'];
const FIELD: Layer[] = ['structure', 'field-writer', 'coordinates'];
const DAY = 'DailyClose.version';

function reportRead(
  path: string,
  scopeSource: ScopeSource,
  projector: { writer: ProjectorName; reader: ProjectorName },
  temporal: { writer: Temporal; reader: Temporal },
  layers: { writer: Layer[]; reader: Layer[] },
): SurfaceEntry {
  return {
    entry: `GET /api/report/${path}`,
    kind: 'read',
    principal: 'account',
    capability: ['report.view', 'report.view-submitted'],
    scopeSource,
    direction: 'n/a',
    temporal: {
      'report.view': temporal.writer,
      'report.view-submitted': temporal.reader,
    },
    layers: {
      'report.view': layers.writer,
      'report.view-submitted': layers.reader,
    },
    projector: {
      'report.view': projector.writer,
      'report.view-submitted': projector.reader,
    },
    concurrency: 'read',
    advances: [],
    discloses: 'none',
  };
}
function write(
  entry: string,
  principal: Principal,
  capability: Capability,
  scopeSource: ScopeSource,
  command: string,
  concurrency: Exclude<Concurrency, 'read'>,
  versions: { protects?: string[]; advances?: string[] } = {},
  extra: Partial<SurfaceEntry> = {},
): SurfaceEntry {
  return {
    entry,
    kind: 'write',
    principal,
    capability: [capability],
    scopeSource,
    direction: 'n/a',
    temporal: { [capability]: 'live' },
    layers: { [capability]: [] },
    command,
    concurrency,
    ...(versions.protects ? { protects: versions.protects } : {}),
    advances: versions.advances ?? [],
    discloses: 'none',
    ...extra,
  };
}
function read(
  entry: string,
  principal: Principal,
  capability: Capability[],
  scopeSource: ScopeSource,
  per: Partial<
    Record<
      Capability,
      { temporal: Temporal; layers: Layer[]; projector: ProjectorName }
    >
  >,
  extra: Partial<SurfaceEntry> = {},
): SurfaceEntry {
  const temporal: SurfaceEntry['temporal'] = {};
  const layers: SurfaceEntry['layers'] = {};
  const projector: NonNullable<SurfaceEntry['projector']> = {};
  for (const c of capability) {
    const p = per[c]!;
    temporal[c] = p.temporal;
    layers[c] = p.layers;
    projector[c] = p.projector;
  }
  return {
    entry,
    kind: 'read',
    principal,
    capability,
    scopeSource,
    direction: 'n/a',
    temporal,
    layers,
    projector,
    concurrency: 'read',
    advances: [],
    discloses: 'none',
    ...extra,
  };
}
const fieldAdminRead = (path: string, projector: ProjectorName) =>
  read(
    `GET /api/report/field/${path}`,
    'account',
    ['field.admin.view'],
    'query.projectId',
    { 'field.admin.view': { temporal: 'live', layers: FIELD, projector } },
  );
const fieldAdminWrite = (
  path: string,
  command: string,
  concurrency: Exclude<Concurrency, 'read'>,
  versions: { protects?: string[]; advances?: string[] } = {},
) =>
  write(
    `POST /api/report/field/${path}`,
    'account',
    'field.admin.write',
    'body.projectId',
    command,
    concurrency,
    versions,
  );
const issueWrite = (
  path: string,
  capability: Capability,
  scopeSource: ScopeSource,
  command: string,
  concurrency: Exclude<Concurrency, 'read'>,
  versions: { protects?: string[]; advances?: string[] } = {},
) =>
  write(
    `POST /api/report/issues${path}`,
    'account',
    capability,
    scopeSource,
    command,
    concurrency,
    versions,
  );
const photoRead = (
  path: string,
  writer: ProjectorName,
  reader: ProjectorName,
) =>
  read(
    `GET /api/report/photos${path}`,
    'account',
    ['photo.view', 'photo.view-frozen'],
    path === '' ? 'query.projectId' : 'path.photoId',
    {
      'photo.view': { temporal: 'live', layers: PHOTO_LIVE, projector: writer },
      'photo.view-frozen': {
        temporal: 'frozen',
        layers: PHOTO_FROZEN,
        projector: reader,
      },
    },
  );
const ISSUE_VERSION = {
  protects: ['Issue.version'],
  advances: ['Issue.version'],
};
const ROSTER = {
  protects: ['ProjectRoster.version'],
  advances: ['ProjectRoster.version'],
};
const DEVICE = {
  protects: ['FieldDevice.version'],
  advances: ['FieldDevice.version'],
};

const ENTRIES: readonly SurfaceEntry[] = [
  // ---------- platform ----------
  read(
    'GET /health/live',
    'none',
    ['public'],
    'none',
    {
      public: {
        temporal: 'live',
        layers: STRUCTURE,
        projector: 'public.health',
      },
    },
    { outsideD1: true },
  ),
  read(
    'GET /api/auth-config',
    'none',
    ['public'],
    'none',
    {
      public: {
        temporal: 'live',
        layers: STRUCTURE,
        projector: 'public.authConfig',
      },
    },
    { outsideD1: true },
  ),

  // ---------- Alpha site days (pre-report slice; AlphaStore) ----------
  read(
    'GET /api/projects',
    'account',
    ['alpha.view'],
    'membership',
    {
      'alpha.view': {
        temporal: 'live',
        layers: STRUCTURE,
        projector: 'AlphaStore.projects',
      },
    },
    { outsideD1: true },
  ),
  read(
    'GET /api/site-days',
    'account',
    ['alpha.view'],
    'query.projectId',
    {
      'alpha.view': {
        temporal: 'live',
        layers: ALL,
        projector: 'AlphaStore.list',
      },
    },
    { outsideD1: true },
  ),
  read(
    'GET /api/site-days/:recordId',
    'account',
    ['alpha.view'],
    'path.recordId',
    {
      'alpha.view': {
        temporal: 'live',
        layers: ALL,
        projector: 'AlphaStore.get',
      },
    },
    { outsideD1: true },
  ),
  write(
    'POST /api/site-days/save',
    'account',
    'alpha.write',
    'body.projectId',
    'AlphaStore.save',
    'cas',
    {
      protects: ['DailyClose.version(alpha)'],
      advances: ['DailyClose.version(alpha)'],
    },
    { outsideD1: true },
  ),

  // ---------- report (exit: reportReader.forContext) ----------
  read(
    'GET /api/report/projects',
    'account',
    ['report.view', 'report.view-submitted'],
    'membership',
    {
      'report.view': {
        temporal: 'live',
        layers: STRUCTURE,
        projector: 'report.projects',
      },
      'report.view-submitted': {
        temporal: 'live',
        layers: STRUCTURE,
        projector: 'report.projects',
      },
    },
  ),
  reportRead(
    'days',
    'query.projectId',
    { writer: 'report.days.writer', reader: 'report.days.reader' },
    { writer: 'live', reader: 'submitted' },
    { writer: ALL, reader: SUBMITTED },
  ),
  reportRead(
    'day',
    'query.projectId',
    { writer: 'report.day.writer', reader: 'report.day.reader' },
    { writer: 'live', reader: 'submitted' },
    { writer: ALL, reader: SUBMITTED },
  ),
  reportRead(
    'revision',
    'query.projectId',
    { writer: 'report.revision.writer', reader: 'report.revision.reader' },
    { writer: 'frozen', reader: 'frozen' },
    { writer: ALL, reader: SUBMITTED },
  ),
  reportRead(
    'plan',
    'query.projectId',
    { writer: 'report.plan.writer', reader: 'report.plan.reader' },
    { writer: 'live', reader: 'submitted' },
    { writer: ALL, reader: SUBMITTED },
  ),
  reportRead(
    'items',
    'query.projectId',
    { writer: 'report.items', reader: 'report.items' },
    { writer: 'live', reader: 'live' },
    { writer: STRUCTURE, reader: STRUCTURE },
  ),
  ...(
    [
      ['facts', 'ReportStore.saveFacts', 'cas'],
      ['submit', 'ReportStore.submit', 'cas'],
      ['no-work', 'ReportStore.noWork', 'cas'],
      ['correction/start', 'ReportStore.startCorrection', 'cas'],
      ['correction/cancel', 'ReportStore.cancelCorrection', 'cas'],
    ] as const
  ).map(([path, command, mode]) =>
    write(
      `POST /api/report/${path}`,
      'account',
      'report.write',
      'body.projectId',
      command,
      mode,
      { protects: [DAY], advances: [DAY] },
    ),
  ),
  write(
    'POST /api/report/plan/draft',
    'account',
    'report.write',
    'body.projectId',
    'ReportStore.savePlanDraft',
    'legacy-overwrite',
  ),
  write(
    'POST /api/report/plan/confirm',
    'account',
    'report.write',
    'body.projectId',
    'ReportStore.confirmPlan',
    'create',
    { advances: ['PlanVersion.number'] },
  ),
  write(
    'POST /api/report/items',
    'account',
    'report.write',
    'body.projectId',
    'ReportStore.saveItems',
    'legacy-overwrite',
  ),
  write(
    'POST /api/report/foreman/adopt',
    'account',
    'report.write',
    'body.projectId',
    'ReportStore.adoptForeman',
    'cas',
    {
      protects: [DAY, 'ForemanReportRevision.n'],
      advances: [DAY, 'FieldDay.seq'],
    },
  ),

  // ---------- issues ----------
  read('GET /api/report/issues', 'account', ['issue.view'], 'query.projectId', {
    'issue.view': { temporal: 'live', layers: ISSUE, projector: 'issue.list' },
  }),
  read(
    'GET /api/report/issues/lag',
    'account',
    ['issue.view'],
    'query.projectId',
    {
      'issue.view': {
        temporal: 'submitted',
        layers: ['structure', 'submitted'],
        projector: 'issue.lag',
      },
    },
  ),
  read(
    'GET /api/report/issues/:issueId',
    'account',
    ['issue.view'],
    'path.issueId',
    {
      'issue.view': { temporal: 'live', layers: ISSUE, projector: 'issue.get' },
    },
  ),
  issueWrite(
    '',
    'issue.write',
    'body.projectId',
    'IssueStore.create',
    'create',
    {
      advances: ['Issue.version'],
    },
  ),
  issueWrite(
    '/note',
    'issue.write',
    'body.issueId',
    'IssueStore.note',
    'cas',
    ISSUE_VERSION,
  ),
  issueWrite(
    '/escalate',
    'issue.write',
    'body.issueId',
    'IssueStore.setEscalate',
    'cas',
    ISSUE_VERSION,
  ),
  issueWrite(
    '/close',
    'issue.write',
    'body.issueId',
    'IssueStore.close',
    'cas',
    ISSUE_VERSION,
  ),
  issueWrite(
    '/reopen',
    'issue.write',
    'body.issueId',
    'IssueStore.reopen',
    'cas',
    ISSUE_VERSION,
  ),
  issueWrite(
    '/reply',
    'issue.reply',
    'body.issueId',
    'IssueStore.reply',
    'append',
  ),
  issueWrite(
    '/lag/dismiss',
    'issue.write',
    'body.projectId',
    'IssueStore.dismissLag',
    'create',
  ),

  // ---------- photos ----------
  photoRead('', 'photo.list.writer', 'photo.list.reader'),
  photoRead('/:photoId/meta', 'photo.meta.writer', 'photo.meta.reader'),
  photoRead('/:photoId', 'photo.content', 'photo.content'),
  photoRead('/:photoId/thumbnail', 'photo.content', 'photo.content'),
  write(
    'POST /api/report/photos',
    'account',
    'photo.write',
    'body.projectId',
    'PhotoStore.upload',
    'create',
    {},
    {
      discloses: {
        kind: 'existence',
        code: 'PHOTO_ELSEWHERE',
        basis:
          'OD20 (the same file is one fact); ADR-0003 D3 registered exception',
      },
    },
  ),
  ...(['link', 'unlink'] as const).map((path) =>
    write(
      `POST /api/report/photos/${path}`,
      'account',
      'photo.write',
      'body.photoId',
      `PhotoStore.${path}`,
      'cas',
      {
        protects: ['PhotoEvidence.linkVersion'],
        advances: ['PhotoEvidence.linkVersion'],
      },
    ),
  ),

  // ---------- field administration (writer-only; no reader capability) ----------
  fieldAdminRead('entry-code', 'FieldStore.entryCode'),
  fieldAdminRead('roster', 'FieldStore.roster'),
  fieldAdminRead('devices', 'FieldStore.devices'),
  fieldAdminWrite('crews', 'FieldStore.createCrew', 'cas', ROSTER),
  fieldAdminWrite('crews/end', 'FieldStore.endCrew', 'cas', ROSTER),
  fieldAdminWrite('roster/changes', 'FieldStore.changeRoster', 'cas', {
    protects: ROSTER.protects,
    // recomputeDevices ends devices whose person left the roster
    advances: [
      ...ROSTER.advances,
      'FieldDevice.version',
      'FieldDevice.current(person)',
    ],
  }),
  fieldAdminWrite('devices/confirm', 'FieldStore.pmConfirm', 'cas', {
    protects: ['FieldDevice.current(person)'],
    advances: ['FieldDevice.version', 'FieldDevice.current(person)'],
  }),
  fieldAdminWrite('devices/reject', 'FieldStore.pmDevice', 'cas', DEVICE),
  fieldAdminWrite('devices/revoke', 'FieldStore.pmDevice', 'cas', {
    protects: DEVICE.protects,
    // revoking the confirmed device changes the person's current device
    advances: [...DEVICE.advances, 'FieldDevice.current(person)'],
  }),
  fieldAdminWrite(
    'entry-code/rotate',
    'FieldStore.rotateEntryCode',
    'legacy-overwrite',
  ),
  fieldAdminRead('checkins', 'CheckInStore.checkIns'),
  fieldAdminRead('checkins/selfie', 'CheckInStore.selfie'),
  fieldAdminWrite('checkins/proxy', 'CheckInStore.pmProxy', 'create', {
    advances: ['FieldDay.seq'],
  }),
  fieldAdminWrite('checkins/void', 'CheckInStore.voidCheckIn', 'append', {
    advances: ['FieldDay.seq'],
  }),
  fieldAdminRead('settings', 'CheckInStore.settings'),
  fieldAdminWrite('settings', 'CheckInStore.setSettings', 'cas', {
    protects: ['ProjectFieldSetting.n'],
    advances: ['ProjectFieldSetting.n'],
  }),
  fieldAdminWrite('site-reference', 'CheckInStore.setSiteReference', 'cas', {
    protects: ['ProjectSiteReference.n'],
    advances: ['ProjectSiteReference.n'],
  }),

  // ---------- field devices (A6; device principal fixed to one project and person) ----------
  write(
    'POST /api/field/entry',
    'none',
    'field.device.enroll',
    'body.code',
    'FieldStore.entry',
    'append',
    {},
    {
      outsideD1: true,
      discloses: {
        kind: 'existence',
        code: 'entry roster',
        basis:
          'A6 entry flow: a valid entry code shows its project roster names to pick a person',
      },
    },
  ),
  write(
    'POST /api/field/bind',
    'none',
    'field.device.enroll',
    'body.code',
    'FieldStore.bind',
    'create',
    {},
    { outsideD1: true },
  ),
  read('GET /api/field/me', 'fieldDevice', ['field.device.session'], 'device', {
    'field.device.session': {
      temporal: 'live',
      layers: ['structure', 'field-writer'],
      projector: 'FieldStore.me',
    },
  }),
  write(
    'POST /api/field/device/challenge',
    'fieldDevice',
    'field.device.session',
    'device',
    'FieldStore.challenge',
    'create',
  ),
  write(
    'POST /api/field/device/release',
    'fieldDevice',
    'field.device.session',
    'device',
    'FieldStore.release',
    'append',
    { advances: ['FieldDevice.version', 'FieldDevice.current(person)'] },
  ),
  write(
    'POST /api/field/device/rotate',
    'fieldDevice',
    'field.device.session',
    'device',
    'FieldStore.rotate',
    'cas',
    {
      protects: ['FieldDevice.generation'],
      advances: ['FieldDevice.generation'],
    },
  ),
  write(
    'POST /api/field/devices/confirm',
    'fieldDevice',
    'field.device.session',
    'device',
    'FieldStore.confirm',
    'cas',
    {
      protects: ['FieldDevice.current(person)'],
      advances: ['FieldDevice.version', 'FieldDevice.current(person)'],
    },
  ),
  write(
    'POST /api/field/devices/reject',
    'fieldDevice',
    'field.device.session',
    'device',
    'FieldStore.reject',
    'append',
    { advances: ['FieldDevice.version'] },
  ),
  write(
    'POST /api/field/checkin',
    'fieldDevice',
    'field.device.checkin',
    'device',
    'CheckInStore.checkIn',
    'create',
    { advances: ['FieldDay.seq'] },
  ),
  write(
    'POST /api/field/checkin/proxy',
    'fieldDevice',
    'field.device.foreman',
    'device',
    'CheckInStore.proxyCheckIn',
    'create',
    { advances: ['FieldDay.seq'] },
  ),
  write(
    'POST /api/field/selfie',
    'fieldDevice',
    'field.device.selfie',
    'device',
    'CheckInStore.uploadSelfie',
    'create',
  ),
  read(
    'GET /api/field/report',
    'fieldDevice',
    ['field.device.foreman'],
    'device',
    {
      'field.device.foreman': {
        temporal: 'live',
        layers: ['structure', 'field-writer'],
        projector: 'ForemanStore.report',
      },
    },
  ),
  write(
    'POST /api/field/report',
    'fieldDevice',
    'field.device.foreman',
    'device',
    'ForemanStore.submitReport',
    'cas',
    {
      protects: ['ForemanReportRevision.n'],
      advances: ['ForemanReportRevision.n', 'FieldDay.seq'],
    },
  ),

  // ---------- Worker / CLI ----------
  {
    entry: 'worker:apps/worker/src/main.ts',
    kind: 'read',
    principal: 'system',
    capability: ['system.boot'],
    scopeSource: 'none',
    direction: 'n/a',
    temporal: { 'system.boot': 'live' },
    layers: { 'system.boot': [] },
    projector: { 'system.boot': 'system.none' },
    concurrency: 'read',
    advances: [],
    discloses: 'none',
    outsideD1: true,
  },
  {
    entry: 'cli:apps/api/src/cleanup-selfies.ts',
    kind: 'write',
    principal: 'system',
    capability: ['system.selfie-cleanup'],
    scopeSource: 'cli.orgId',
    direction: 'n/a',
    temporal: { 'system.selfie-cleanup': 'live' },
    layers: { 'system.selfie-cleanup': [] },
    command: 'CheckInStore.cleanupSelfies',
    concurrency: 'append',
    advances: [],
    discloses: 'none',
    outsideD1: true,
  },
];

/**
 * Every device-authenticated request runs in fieldTransaction (field-kit), which ends a device
 * whose membership or roster lapsed when it observes that (endDevice: FieldDevice.version, and
 * the person's current device). So every device entry, read or write, may advance both.
 */
const DEVICE_EXPIRY = ['FieldDevice.version', 'FieldDevice.current(person)'];
export const SURFACE: readonly SurfaceEntry[] = ENTRIES.map((e) =>
  e.principal === 'fieldDevice'
    ? { ...e, advances: [...new Set([...e.advances, ...DEVICE_EXPIRY])] }
    : e,
);

/** The Worker / CLI entry files the entry scan expects (repository-relative). */
export const PROCESS_ENTRIES = SURFACE.filter(
  (e) => e.entry.startsWith('worker:') || e.entry.startsWith('cli:'),
).map((e) => e.entry.slice(e.entry.indexOf(':') + 1));
