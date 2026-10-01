/**
 * ADR-0003 D6 anchors: hand-written scenarios with the expected decision and visible field
 * paths, written from the confirmed rules (D1 transition table, OD18, OD20, A6.0), never
 * generated. They pin the TEST interpreter (interpret.ts), which reads only surface.ts and
 * fields.ts; production authorization is not called.
 */
import { describe, expect, it } from 'vitest';
import { decide, type TestContext } from './interpret.js';
import { SURFACE, type Capability } from './surface.js';

const entry = (name: string) => {
  const e = SURFACE.find((x) => x.entry === name);
  if (!e) throw new Error(`no surface entry ${name}`);
  return e;
};
const account = (
  capabilities: Capability[],
  scope: TestContext['scope'] = 'granted',
): TestContext => ({ principal: 'account', capabilities, scope });
/** PROJECT_MANAGER on the project (D1 write column). */
const PM: Capability[] = [
  'report.view',
  'report.write',
  'issue.view',
  'issue.write',
  'photo.view',
  'photo.write',
  'field.admin.view',
  'field.admin.write',
];
/** EXECUTIVE_READER on the project (D1 read column). */
const READER: Capability[] = [
  'report.view-submitted',
  'issue.view',
  'issue.reply',
  'photo.view-frozen',
];
const DEVICE: TestContext = {
  principal: 'fieldDevice',
  capabilities: ['field.device.session', 'field.device.checkin'],
  scope: 'granted',
};

const photoKeys = (prefix: string, exact: boolean) =>
  [
    'id',
    'projectId',
    'businessDate',
    'source',
    'mediaType',
    'sizeBytes',
    'sha256',
    'capture',
    'capture.accuracyM',
    'capture.fixAt',
    'deviceCapturedAt',
    'file',
    'file.takenLocal',
    'file.takenAt',
    'location',
    'coordinates',
    'hasThumbnail',
    'receivedAt',
    'uploadedByPersonId',
    'link',
    'linkVersion',
    ...(exact ? ['capture.lat', 'capture.lon', 'file.gps'] : []),
  ].map((k) => `${prefix}${k}`);
const DAY_KEYS = [
  'access',
  'projectId',
  'businessDate',
  'siteTimezone',
  'state',
  'version',
  'currentRevisionNumber',
  'correctionReason',
  'facts',
  'items',
  'planStatus',
  'baseline',
  'nextPlan',
  'previousSubmittedDate',
  'cumulativeBase',
  'materialsCumulative',
  'issues',
  'photos',
  'unlinkedPhotos',
  'coverage',
  'revisions',
];
const sorted = (keys: string[]) => [...keys].sort();

describe('ADR-0003 anchors (hand-written)', () => {
  const cases: {
    name: string;
    entry: string;
    ctx: TestContext;
    allowed: boolean;
    capability?: Capability;
    keys?: string[];
  }[] = [
    {
      name: 'PM lists days: all three row keys, from the writer projector',
      entry: 'GET /api/report/days',
      ctx: account(PM),
      allowed: true,
      capability: 'report.view',
      keys: ['[].businessDate', '[].state', '[].revision'],
    },
    {
      name: 'reader lists days: same keys (draft rows are left out by the projector, OD18)',
      entry: 'GET /api/report/days',
      ctx: account(READER),
      allowed: true,
      capability: 'report.view-submitted',
      keys: ['[].businessDate', '[].state', '[].revision'],
    },
    {
      name: 'reader day: no foreman, no exact coordinates (OD18, OD20, A6.0)',
      entry: 'GET /api/report/day',
      ctx: account(READER),
      allowed: true,
      capability: 'report.view-submitted',
      keys: [...DAY_KEYS, ...photoKeys('photos[].', false)],
    },
    {
      name: 'PM day: everything, with foreman and exact coordinates',
      entry: 'GET /api/report/day',
      ctx: account(PM),
      allowed: true,
      capability: 'report.view',
      keys: [...DAY_KEYS, 'foreman', ...photoKeys('photos[].', true)],
    },
    {
      name: 'reader revision: the snapshot only through readerSnapshot',
      entry: 'GET /api/report/revision',
      ctx: account(READER),
      allowed: true,
      capability: 'report.view-submitted',
      keys: ['n', 'at', 'by', 'reason', 'snapshot'],
    },
    {
      name: 'reader plan: confirmed versions; the draft key carries null',
      entry: 'GET /api/report/plan',
      ctx: account(READER),
      allowed: true,
      capability: 'report.view-submitted',
      keys: ['targetBusinessDate', 'status', 'rows', 'draft', 'versions'],
    },
    {
      name: 'reader photo list: frozen photos without coordinates',
      entry: 'GET /api/report/photos',
      ctx: account(READER),
      allowed: true,
      capability: 'photo.view-frozen',
      keys: [
        'access',
        'projectId',
        'businessDate',
        'photos',
        'unlinkedPhotos',
        ...photoKeys('photos[].', false),
      ],
    },
    {
      name: 'reader lag: submitted history only',
      entry: 'GET /api/report/issues/lag',
      ctx: account(READER),
      allowed: true,
      capability: 'issue.view',
      keys: ['projectId', 'businessDate', 'suggestions'],
    },
    {
      name: 'reader cannot submit',
      entry: 'POST /api/report/submit',
      ctx: account(READER),
      allowed: false,
    },
    {
      name: 'reader replies to an issue (its only write)',
      entry: 'POST /api/report/issues/reply',
      ctx: account(READER),
      allowed: true,
      capability: 'issue.reply',
      keys: [],
    },
    {
      name: 'PM has no issue.reply',
      entry: 'POST /api/report/issues/reply',
      ctx: account(PM),
      allowed: false,
    },
    {
      name: 'PM on another project of the org: denied',
      entry: 'GET /api/report/day',
      ctx: account(PM, 'other-project'),
      allowed: false,
    },
    {
      name: 'PM in another org: denied',
      entry: 'POST /api/report/facts',
      ctx: account(PM, 'other-org'),
      allowed: false,
    },
    {
      name: 'project list is membership-scoped: allowed, structure only',
      entry: 'GET /api/report/projects',
      ctx: account(READER, 'other-project'),
      allowed: true,
      capability: 'report.view-submitted',
      keys: ['accountId', 'personId', 'projects'],
    },
    {
      name: 'reader has no field administration',
      entry: 'GET /api/report/field/roster',
      ctx: account(READER),
      allowed: false,
    },
    {
      name: 'a device cannot read a report day',
      entry: 'GET /api/report/day',
      ctx: DEVICE,
      allowed: false,
    },
    {
      name: 'a device checks in',
      entry: 'POST /api/field/checkin',
      ctx: DEVICE,
      allowed: true,
      capability: 'field.device.checkin',
      keys: [],
    },
    {
      name: 'health needs no principal',
      entry: 'GET /health/live',
      ctx: { principal: 'none', capabilities: ['public'], scope: 'granted' },
      allowed: true,
      capability: 'public',
      keys: [],
    },
  ];
  for (const c of cases)
    it(c.name, () => {
      const d = decide(entry(c.entry), c.ctx);
      expect(d.allowed).toBe(c.allowed);
      if (!c.allowed) {
        expect(d.capability).toBeNull();
        expect(d.visibleKeys).toEqual([]);
        return;
      }
      expect(d.capability).toBe(c.capability);
      expect(sorted(d.visibleKeys)).toEqual(sorted(c.keys!));
    });
});
