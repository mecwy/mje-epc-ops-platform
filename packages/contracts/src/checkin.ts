/**
 * Worker check-in and staged selfie boundary DTOs (A6b; design
 * docs/architecture/a6-field-devices-design.md §3, §6). A check-in is the claim "P was on site
 * at T": it never becomes hours and never fills headcount (U8). Field bodies carry no projectId
 * (the project is the device's). Coordinates are decimal strings; they are never echoed in a
 * response, an error, an event or an audit row.
 */
import { isRealTimestamp } from './report.js';
import {
  InvalidReportInput,
  date,
  id,
  obj,
  oneOf,
  str,
  version,
} from './parse.js';

export const CHECKIN_KINDS = ['SELF', 'FOREMAN_PROXY', 'PM_PROXY'] as const;
export type CheckInKind = (typeof CHECKIN_KINDS)[number];
export const CHECKIN_FLAGS = [
  'LATE',
  'NEAR_EDGE',
  'MULTI_PROJECT_DAY',
  'REMOTE_PROXY',
  'PROXY_LOCATION_COARSE',
  'PROXY_LOCATION_UNAVAILABLE',
] as const;
export type CheckInFlag = (typeof CHECKIN_FLAGS)[number];
export const PROXY_SOURCES = [
  'OBSERVED_ON_SITE',
  'FOREMAN_REPORTED',
  'OTHER',
] as const;
export type ProxySource = (typeof PROXY_SOURCES)[number];
/** EXACT: the crew at occurredAt; ONLY_CREW_OF_DAY: the one crew overlapping the day. */
export const CREW_ATTRIBUTIONS = [
  'OCCURRED_AT',
  'ONLY_CREW_OF_DAY',
  'UNKNOWN',
] as const;
export type CrewAttribution = (typeof CREW_ATTRIBUTIONS)[number];
export const RADIUS_MIN_M = 50;
export const RADIUS_MAX_M = 2000;
export const PM_PROXY_DAYS_MAX = 30;
export const VOID_REASON_MAX = 500;
export const PROXY_REASON_MAX = 500;

/** A device fix as the phone reports it (decimal strings; accuracy in metres). */
export interface FixInput {
  lat: string;
  lon: string;
  accuracyM: string;
  fixAt: string;
}
/** Self check-in. `deviceSentAt` is transport (the device clock at this attempt), not hashed. */
export interface CheckInCommand {
  clientMutationId: string;
  businessDate: string;
  occurredAt: string;
  fix: FixInput;
  stagedSelfieId: string | null;
  deviceSentAt: string;
}
/** Foreman proxy: the foreman's own fix and clock; the subject is a member of the foreman's crew. */
export interface ProxyCheckInCommand {
  clientMutationId: string;
  personId: string;
  businessDate: string;
  occurredAt: string;
  fix: FixInput;
  deviceSentAt: string;
}
/** PM proxy (Entra). Without `occurredAt` the time precision is DAY: no time is invented. */
export interface PmProxyCheckInCommand {
  projectId: string;
  clientMutationId: string;
  personId: string;
  businessDate: string;
  occurredAt: string | null;
  source: ProxySource;
  /** Required when the date is not the site's today or when no in-fence fix exists. */
  reason: string;
  /** The PM's own current fix; stored only as the actor's location, never the worker's. */
  actorFix: FixInput | null;
}
export interface VoidCheckInCommand {
  projectId: string;
  clientMutationId: string;
  checkInId: string;
  reason: string;
}
export interface SiteReferenceCommand {
  projectId: string;
  clientMutationId: string;
  /** The current reference number as last read (0 = none yet). */
  expectedN: number;
  lat: string;
  lon: string;
  radiusM: number;
}
export interface FieldSettingsCommand {
  projectId: string;
  clientMutationId: string;
  expectedN: number;
  /** U1: off by default; enabled only after HR/legal confirm. */
  selfieEnabled: boolean;
  /** How many days back a PM proxy may go (default 7). */
  pmProxyDays: number;
}

export interface CheckInResultDto {
  checkInId: string;
  businessDate: string;
  kind: CheckInKind;
  occurredAt: string | null;
  timePrecision: 'EXACT' | 'DAY';
  flags: CheckInFlag[];
  hasSelfie: boolean;
  /** Recorded after the day's latest submitted revision: enters only through a correction. */
  afterSubmission: boolean;
}
export interface SelfieUploadDto {
  selfieId: string;
  expiresAt: string;
}
export interface CheckInRowDto {
  checkInId: string;
  personId: string;
  displayName: string;
  kind: CheckInKind;
  occurredAt: string | null;
  timePrecision: 'EXACT' | 'DAY';
  crewId: string | null;
  crewAttribution: CrewAttribution;
  flags: CheckInFlag[];
  source: ProxySource | null;
  /** Rounded metres from the site reference of the fix used (worker's or actor's); no coordinates. */
  distanceM: number | null;
  /** ATTACHED: viewable; DELETED: had a selfie, deleted by retention. */
  selfie: 'NONE' | 'ATTACHED' | 'DELETED';
  daySeq: number;
  afterSubmission: boolean;
  voided: { at: string; reason: string } | null;
}
export interface CheckInListDto {
  projectId: string;
  businessDate: string;
  /** The field sequence the latest submitted revision froze; null = not submitted. */
  seqBoundary: number | null;
  /** Distinct persons with a non-voided check-in; never "on site now", hours or verified. */
  summary: { present: number; self: number; proxy: number; flagged: number };
  checkIns: CheckInRowDto[];
}
export interface FieldSettingsDto {
  projectId: string;
  siteReference: {
    n: number;
    lat: string;
    lon: string;
    radiusM: number;
  } | null;
  settings: { n: number; selfieEnabled: boolean; pmProxyDays: number };
}

/** Latitude/longitude as stored (up to 6 decimals), inside the globe. */
const COORD = /^-?\d{1,3}(\.\d{1,6})?$/;
/** Accuracy radius in metres: up to 6 integer digits and 2 decimals. */
const ACCURACY = /^\d{1,6}(\.\d{1,2})?$/;
function coordinate(v: unknown, field: string, limit: number): string {
  const s = str(v, field, 12);
  if (!COORD.test(s) || !(Math.abs(Number(s)) <= limit))
    throw new InvalidReportInput(field);
  return s;
}
function instant(v: unknown, field: string): string {
  const s = str(v, field, 40);
  if (!isRealTimestamp(s)) throw new InvalidReportInput(field);
  return s;
}
export function parseFix(v: unknown, field: string): FixInput {
  const o = obj(v, field);
  const accuracyM = str(o['accuracyM'], `${field}.accuracyM`, 12);
  if (!ACCURACY.test(accuracyM))
    throw new InvalidReportInput(`${field}.accuracyM`);
  return {
    lat: coordinate(o['lat'], `${field}.lat`, 90),
    lon: coordinate(o['lon'], `${field}.lon`, 180),
    accuracyM,
    fixAt: instant(o['fixAt'], `${field}.fixAt`),
  };
}
function reasonText(v: unknown, field: string, max: number): string {
  return str(v ?? '', field, max).trim();
}
export function parseCheckInCommand(v: unknown): CheckInCommand {
  const o = obj(v, 'command');
  const selfie = o['stagedSelfieId'];
  return {
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    businessDate: date(o['businessDate'], 'businessDate'),
    occurredAt: instant(o['occurredAt'], 'occurredAt'),
    fix: parseFix(o['fix'], 'fix'),
    stagedSelfieId:
      selfie === undefined || selfie === null
        ? null
        : id(selfie, 'stagedSelfieId'),
    deviceSentAt: instant(o['deviceSentAt'], 'deviceSentAt'),
  };
}
export function parseProxyCheckInCommand(v: unknown): ProxyCheckInCommand {
  const o = obj(v, 'command');
  return {
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    personId: id(o['personId'], 'personId'),
    businessDate: date(o['businessDate'], 'businessDate'),
    occurredAt: instant(o['occurredAt'], 'occurredAt'),
    fix: parseFix(o['fix'], 'fix'),
    deviceSentAt: instant(o['deviceSentAt'], 'deviceSentAt'),
  };
}
export function parsePmProxyCheckInCommand(v: unknown): PmProxyCheckInCommand {
  const o = obj(v, 'command');
  const occurred = o['occurredAt'];
  const fix = o['actorFix'];
  return {
    projectId: id(o['projectId'], 'projectId'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    personId: id(o['personId'], 'personId'),
    businessDate: date(o['businessDate'], 'businessDate'),
    occurredAt:
      occurred === undefined || occurred === null || occurred === ''
        ? null
        : instant(occurred, 'occurredAt'),
    source: oneOf(o['source'], PROXY_SOURCES, 'source'),
    reason: reasonText(o['reason'], 'reason', PROXY_REASON_MAX),
    actorFix:
      fix === undefined || fix === null ? null : parseFix(fix, 'actorFix'),
  };
}
export function parseVoidCheckInCommand(v: unknown): VoidCheckInCommand {
  const o = obj(v, 'command');
  const reason = reasonText(o['reason'], 'reason', VOID_REASON_MAX);
  if (!reason) throw new InvalidReportInput('reason');
  return {
    projectId: id(o['projectId'], 'projectId'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    checkInId: id(o['checkInId'], 'checkInId'),
    reason,
  };
}
function intIn(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    throw new InvalidReportInput(field);
  return v;
}
export function parseSiteReferenceCommand(v: unknown): SiteReferenceCommand {
  const o = obj(v, 'command');
  return {
    projectId: id(o['projectId'], 'projectId'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    expectedN: version(o['expectedN'], 'expectedN'),
    lat: coordinate(o['lat'], 'lat', 90),
    lon: coordinate(o['lon'], 'lon', 180),
    radiusM: intIn(o['radiusM'], 'radiusM', RADIUS_MIN_M, RADIUS_MAX_M),
  };
}
export function parseFieldSettingsCommand(v: unknown): FieldSettingsCommand {
  const o = obj(v, 'command');
  if (typeof o['selfieEnabled'] !== 'boolean')
    throw new InvalidReportInput('selfieEnabled');
  return {
    projectId: id(o['projectId'], 'projectId'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    expectedN: version(o['expectedN'], 'expectedN'),
    selfieEnabled: o['selfieEnabled'],
    pmProxyDays: intIn(o['pmProxyDays'], 'pmProxyDays', 1, PM_PROXY_DAYS_MAX),
  };
}
/** Multipart text fields of a selfie upload; anything else is refused. */
export const UPLOAD_SELFIE_FIELDS = ['clientMutationId'] as const;
export function parseSelfieUploadCommand(v: unknown): {
  clientMutationId: string;
} {
  const o = obj(v, 'command');
  for (const k of Object.keys(o))
    if (!(UPLOAD_SELFIE_FIELDS as readonly string[]).includes(k))
      throw new InvalidReportInput(k);
  return { clientMutationId: id(o['clientMutationId'], 'clientMutationId') };
}
