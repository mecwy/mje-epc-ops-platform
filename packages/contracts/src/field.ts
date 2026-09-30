/**
 * Field boundary DTOs (A6a: roster, field devices, entry). A FieldDevice is a browser-held secret
 * for one Person on one project; it proves only that a PM or the crew foreman confirmed the
 * browser face to face. Roles are never on the device. Field bodies carry no projectId: the
 * project is the device's. Only bind (token) and rotate (newToken) carry a secret in the body.
 */
import { isRealTimestamp } from './report.js';
import {
  InvalidReportInput,
  id,
  isRealDate,
  obj,
  oneOf,
  str,
  version,
} from './parse.js';

/** `fd1.` + base64url of 32 random bytes, generated on the device. */
export const FIELD_TOKEN = /^fd1\.[A-Za-z0-9_-]{43}$/;
/** 128-bit project entry code (base64url, 22 characters), carried in the URL fragment. */
export const ENTRY_CODE = /^[A-Za-z0-9_-]{22}$/;
/** 6-digit confirmation challenge shown on the pending browser. */
export const CHALLENGE_CODE = /^\d{6}$/;
export const CREW_ROLES = ['MEMBER', 'FOREMAN'] as const;
export type CrewRole = (typeof CREW_ROLES)[number];
export const DEVICE_STATES = [
  'PENDING',
  'CONFIRMED',
  'REJECTED',
  'REVOKED',
  'EXPIRED',
] as const;
export type DeviceState = (typeof DEVICE_STATES)[number];
export const ROSTER_CHANGES_MAX = 50;
const NAME_MAX = 80;
const CREW_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export interface EntryCommand {
  code: string;
}
export interface BindCommand {
  code: string;
  personId: string;
  token: string;
}
export interface RotateCommand {
  newToken: string;
  expectedGeneration: number;
}
export interface ReleaseCommand {
  clientMutationId: string;
}
/** Confirm or reject by challenge: the confirmer never picks a device row. */
export interface ChallengeConfirmCommand {
  clientMutationId: string;
  personId: string;
  code: string;
  /** The person's current confirmed device as the confirmer last saw it; null = none. */
  expectedCurrentDeviceId: string | null;
}
export interface ChallengeRejectCommand {
  clientMutationId: string;
  personId: string;
  code: string;
}
export interface PmConfirmCommand extends ChallengeConfirmCommand {
  projectId: string;
}
export interface PmDeviceCommand {
  projectId: string;
  clientMutationId: string;
  deviceId: string;
  expectedVersion: number;
}
export interface RotateEntryCodeCommand {
  projectId: string;
  clientMutationId: string;
}
export interface CreateCrewCommand {
  projectId: string;
  clientMutationId: string;
  expectedRosterVersion: number;
  code: string;
  name: string;
}
export interface EndCrewCommand {
  projectId: string;
  clientMutationId: string;
  expectedRosterVersion: number;
  crewId: string;
  /** ISO-8601; null = the transaction time. */
  at: string | null;
}
export type RosterChange =
  | {
      op: 'open';
      crewId: string;
      personId: string;
      role: CrewRole;
      /** ISO-8601; null = the transaction time. */
      from: string | null;
    }
  | { op: 'close'; assignmentId: string; at: string | null };
export interface RosterChangesCommand {
  projectId: string;
  clientMutationId: string;
  expectedRosterVersion: number;
  /** Applied in one transaction: every close first, then every open. */
  changes: RosterChange[];
}

export interface EntryDto {
  project: { id: string; name: string };
  /** Current project members' display names (U7: intentional disclosure to QR holders). */
  roster: { personId: string; displayName: string; crewName: string }[];
}
export interface FieldDeviceSelfDto {
  deviceId: string;
  state: DeviceState;
  generation: number;
  pendingUntil: string | null;
  expiresAt: string;
  memberUntil: string | null;
  /** When the current token was accepted (bind or last rotation). */
  tokenIssuedAt: string;
}
export interface FieldMeDto {
  device: FieldDeviceSelfDto;
  person: { id: string; displayName: string };
  project: { id: string; name: string; timezone: string };
  crew: { id: string; name: string } | null;
  /** Present for a confirmed device whose person is FOREMAN of a crew now. */
  foreman: {
    crewId: string;
    crewName: string;
    members: {
      personId: string;
      displayName: string;
      /** The member's current confirmed device, for expectedCurrentDeviceId. */
      currentDeviceId: string | null;
      pendingDevices: number;
    }[];
  } | null;
}
export interface ChallengeDto {
  code: string;
  expiresAt: string;
}
/** The outcome of a confirm or reject by challenge. */
export interface DeviceDecisionDto {
  deviceId: string;
  personId: string;
  state: 'CONFIRMED' | 'REJECTED';
}
export interface RotateResultDto {
  generation: number;
}
/** A device as the project manager sees it; never a token or hash. */
export interface FieldDeviceDto {
  id: string;
  personId: string;
  displayName: string;
  state: DeviceState;
  /** The state the timestamps imply now (an unobserved expiry shows EXPIRED). */
  effectiveState: DeviceState;
  endReason: string | null;
  version: number;
  createdAt: string;
  confirmedAt: string | null;
  /** FOREMAN confirmations are marked for PM spot checks (U4). */
  confirmedBy: { kind: 'FOREMAN' | 'PM'; personId: string } | null;
  lastSeenAt: string;
  expiresAt: string;
  memberUntil: string | null;
}
/** One page of the PM device list, newest first; follow `nextCursor` until it is null. */
export interface FieldDeviceListDto {
  devices: FieldDeviceDto[];
  nextCursor: string | null;
}
export interface DeviceListQuery {
  projectId: string;
  /** Position after the last row of the previous page (exact creation time and id). */
  after: { createdAt: string; id: string } | null;
  limit: number;
}
export const DEVICE_PAGE_MAX = 500;
export const DEVICE_PAGE_DEFAULT = 200;
export interface CrewDto {
  id: string;
  code: string;
  name: string;
  activeFrom: string;
  activeUntil: string | null;
}
export interface CrewAssignmentDto {
  id: string;
  crewId: string;
  personId: string;
  displayName: string;
  role: CrewRole;
  validFrom: string;
  validUntil: string | null;
}
export interface RosterDto {
  projectId: string;
  rosterVersion: number;
  crews: CrewDto[];
  assignments: CrewAssignmentDto[];
}

function pattern(v: unknown, re: RegExp, field: string, max: number): string {
  const s = str(v, field, max);
  if (!re.test(s)) throw new InvalidReportInput(field);
  return s;
}
const token = (v: unknown, field: string) => pattern(v, FIELD_TOKEN, field, 47);
const entryCode = (v: unknown) => pattern(v, ENTRY_CODE, 'code', 22);
const challenge = (v: unknown) => pattern(v, CHALLENGE_CODE, 'code', 6);
function name(v: unknown, field: string): string {
  const s = str(v, field, NAME_MAX).trim();
  if (!s) throw new InvalidReportInput(field);
  return s;
}
/** An ISO-8601 instant or "now" (absent, null or ''). */
function instant(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  const s = str(v, field, 40);
  if (!isRealTimestamp(s)) throw new InvalidReportInput(field);
  return s;
}
function nullableId(v: unknown, field: string): string | null {
  return v === null ? null : id(v, field);
}

/** Only a well-formed `Bearer fd1.*` header is a field credential. */
export function fieldBearer(header: unknown): string | null {
  if (typeof header !== 'string' || header.length > 60) return null;
  const m = /^Bearer (fd1\.[A-Za-z0-9_-]{43})$/.exec(header);
  return m ? m[1]! : null;
}
export function parseEntryCommand(v: unknown): EntryCommand {
  return { code: entryCode(obj(v, 'command')['code']) };
}
export function parseBindCommand(v: unknown): BindCommand {
  const o = obj(v, 'command');
  return {
    code: entryCode(o['code']),
    personId: id(o['personId'], 'personId'),
    token: token(o['token'], 'token'),
  };
}
export function parseRotateCommand(v: unknown): RotateCommand {
  const o = obj(v, 'command');
  return {
    newToken: token(o['newToken'], 'newToken'),
    expectedGeneration: version(o['expectedGeneration'], 'expectedGeneration'),
  };
}
export function parseReleaseCommand(v: unknown): ReleaseCommand {
  const o = obj(v, 'command');
  return { clientMutationId: id(o['clientMutationId'], 'clientMutationId') };
}
export function parseChallengeConfirmCommand(
  v: unknown,
): ChallengeConfirmCommand {
  const o = obj(v, 'command');
  if (!('expectedCurrentDeviceId' in o))
    throw new InvalidReportInput('expectedCurrentDeviceId');
  return {
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    personId: id(o['personId'], 'personId'),
    code: challenge(o['code']),
    expectedCurrentDeviceId: nullableId(
      o['expectedCurrentDeviceId'],
      'expectedCurrentDeviceId',
    ),
  };
}
export function parseChallengeRejectCommand(
  v: unknown,
): ChallengeRejectCommand {
  const o = obj(v, 'command');
  return {
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    personId: id(o['personId'], 'personId'),
    code: challenge(o['code']),
  };
}
export function parsePmConfirmCommand(v: unknown): PmConfirmCommand {
  return {
    projectId: id(obj(v, 'command')['projectId'], 'projectId'),
    ...parseChallengeConfirmCommand(v),
  };
}
export function parsePmDeviceCommand(v: unknown): PmDeviceCommand {
  const o = obj(v, 'command');
  return {
    projectId: id(o['projectId'], 'projectId'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    deviceId: id(o['deviceId'], 'deviceId'),
    expectedVersion: version(o['expectedVersion'], 'expectedVersion'),
  };
}
export function parseRotateEntryCodeCommand(
  v: unknown,
): RotateEntryCodeCommand {
  const o = obj(v, 'command');
  return {
    projectId: id(o['projectId'], 'projectId'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
  };
}
function rosterBase(o: Record<string, unknown>) {
  return {
    projectId: id(o['projectId'], 'projectId'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    expectedRosterVersion: version(
      o['expectedRosterVersion'],
      'expectedRosterVersion',
    ),
  };
}
export function parseCreateCrewCommand(v: unknown): CreateCrewCommand {
  const o = obj(v, 'command');
  return {
    ...rosterBase(o),
    code: pattern(o['code'], CREW_CODE, 'code', 32),
    name: name(o['name'], 'name'),
  };
}
export function parseEndCrewCommand(v: unknown): EndCrewCommand {
  const o = obj(v, 'command');
  return {
    ...rosterBase(o),
    crewId: id(o['crewId'], 'crewId'),
    at: instant(o['at'], 'at'),
  };
}
export function parseRosterChangesCommand(v: unknown): RosterChangesCommand {
  const o = obj(v, 'command');
  const list = o['changes'];
  if (
    !Array.isArray(list) ||
    list.length === 0 ||
    list.length > ROSTER_CHANGES_MAX
  )
    throw new InvalidReportInput('changes');
  const changes = list.map((c: unknown, i): RosterChange => {
    const x = obj(c, `changes.${i}`);
    const op = oneOf(x['op'], ['open', 'close'] as const, `changes.${i}.op`);
    return op === 'open'
      ? {
          op,
          crewId: id(x['crewId'], `changes.${i}.crewId`),
          personId: id(x['personId'], `changes.${i}.personId`),
          role: oneOf(x['role'], CREW_ROLES, `changes.${i}.role`),
          from: instant(x['from'], `changes.${i}.from`),
        }
      : {
          op,
          assignmentId: id(x['assignmentId'], `changes.${i}.assignmentId`),
          at: instant(x['at'], `changes.${i}.at`),
        };
  });
  const closes = changes.flatMap((c) =>
    c.op === 'close' ? [c.assignmentId] : [],
  );
  if (new Set(closes).size !== closes.length)
    throw new InvalidReportInput('changes');
  return { ...rosterBase(o), changes };
}

/** Microsecond UTC instant as the device list cursor carries it. */
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/** Shape, calendar date and clock fields (no leap second), keeping all six fraction digits. */
function realCursorTime(t: string): boolean {
  // Year 0000 is a valid JavaScript date but not a PostgreSQL timestamp.
  if (
    !CURSOR_TIME.test(t) ||
    t.startsWith('0000') ||
    !isRealDate(t.slice(0, 10))
  )
    return false;
  const [hh, mm, ss] = t.slice(11, 19).split(':').map(Number);
  return hh! <= 23 && mm! <= 59 && ss! <= 59;
}
/** The opaque cursor after a row: base64url of `<createdAt µs>|<id>`. */
export function encodeDeviceCursor(createdAt: string, id: string): string {
  return btoa(`${createdAt}|${id}`)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
export function parseDeviceListQuery(q: {
  projectId: unknown;
  cursor: unknown;
  limit: unknown;
}): DeviceListQuery {
  const projectId = id(q.projectId, 'projectId');
  let limit = DEVICE_PAGE_DEFAULT;
  if (q.limit !== undefined) {
    const n =
      typeof q.limit === 'string' && /^\d{1,4}$/.test(q.limit)
        ? Number(q.limit)
        : NaN;
    if (!(n >= 1 && n <= DEVICE_PAGE_MAX))
      throw new InvalidReportInput('limit');
    limit = n;
  }
  let after: DeviceListQuery['after'] = null;
  if (q.cursor !== undefined) {
    const raw = pattern(q.cursor, /^[A-Za-z0-9_-]{1,120}$/, 'cursor', 120);
    let decoded: string;
    try {
      decoded = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    } catch {
      throw new InvalidReportInput('cursor');
    }
    const [createdAt, deviceId, rest] = decoded.split('|');
    if (rest !== undefined || !createdAt || !realCursorTime(createdAt))
      throw new InvalidReportInput('cursor');
    after = { createdAt, id: id(deviceId, 'cursor') };
  }
  return { projectId, after, limit };
}
