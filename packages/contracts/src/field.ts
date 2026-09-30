/**
 * Field boundary DTOs, part 1 of A6a: the project roster (crews and crew assignment intervals)
 * and the project entry code. Device DTOs (bind, challenge, confirm, rotate) arrive with A6a-2.
 */
import { isRealTimestamp } from './report.js';
import { InvalidReportInput, id, obj, oneOf, str, version } from './parse.js';

/** 128-bit project entry code (base64url, 22 characters), carried in the URL fragment. */
export const ENTRY_CODE = /^[A-Za-z0-9_-]{22}$/;
export const CREW_ROLES = ['MEMBER', 'FOREMAN'] as const;
export type CrewRole = (typeof CREW_ROLES)[number];
export const ROSTER_CHANGES_MAX = 50;
const NAME_MAX = 80;
const CREW_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export interface EntryCommand {
  code: string;
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
const entryCode = (v: unknown) => pattern(v, ENTRY_CODE, 'code', 22);
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
export function parseEntryCommand(v: unknown): EntryCommand {
  return { code: entryCode(obj(v, 'command')['code']) };
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
