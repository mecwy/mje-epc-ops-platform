/**
 * Issue and escalation boundary DTOs (U2.1 rule 10). An issue is a to-do raised on a site
 * business day; escalation is the project manager's decision, never automatic. Business
 * rules (category required to escalate, expert-controlled close) are enforced by the store.
 */
import { ESCALATION_CATEGORIES, type EscalationCategory } from './report.js';
import {
  InvalidReportInput,
  KEY,
  date,
  id,
  obj,
  oneOf,
  str,
  version,
} from './parse.js';

export const ISSUE_TITLE_MAX = 200;
export const ISSUE_TEXT_MAX = 2000;
export const ISSUE_NOTE_KINDS = ['note', 'reply'] as const;
export type IssueNoteKind = (typeof ISSUE_NOTE_KINDS)[number];

export interface CreateIssueCommand {
  projectId: string;
  /** Site business day the issue is raised on. */
  businessDate: string;
  clientMutationId: string;
  title: string;
  /** '' = no category yet. */
  category: EscalationCategory | '';
  escalate: boolean;
  /** Needs expert confirmation to close. */
  controlled: boolean;
  workItemKey: string | null;
  ownerPersonId: string | null;
  dueOn: string | null;
  /** Optional first note; '' = none. */
  note: string;
}
export interface NoteIssueCommand {
  issueId: string;
  businessDate: string;
  expectedVersion: number;
  clientMutationId: string;
  text: string;
}
export interface SetEscalateCommand {
  issueId: string;
  expectedVersion: number;
  clientMutationId: string;
  escalate: boolean;
  /** '' = keep the current category. */
  category: EscalationCategory | '';
}
export interface CloseIssueCommand {
  issueId: string;
  businessDate: string;
  expectedVersion: number;
  clientMutationId: string;
}
export type ReopenIssueCommand = CloseIssueCommand;
export interface ReplyIssueCommand {
  issueId: string;
  businessDate: string;
  clientMutationId: string;
  text: string;
}
export interface DismissLagCommand {
  projectId: string;
  businessDate: string;
  workItemKey: string;
  clientMutationId: string;
}

function bool(v: unknown, field: string, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') throw new InvalidReportInput(field);
  return v;
}
/** Trimmed, non-empty, bounded text. */
function text(v: unknown, field: string, max: number): string {
  const s = str(v, field, max).trim();
  if (!s) throw new InvalidReportInput(field);
  return s;
}
function category(v: unknown, field: string): EscalationCategory | '' {
  if (v === undefined || v === null || v === '') return '';
  return oneOf(v, ESCALATION_CATEGORIES, field);
}
function key(v: unknown, field: string): string {
  const s = str(v, field, 64);
  if (!KEY.test(s)) throw new InvalidReportInput(field);
  return s;
}
/** Absent, null and '' all mean "not given". */
function optional<T>(
  v: unknown,
  parse: (v: unknown, field: string) => T,
  field: string,
): T | null {
  return v === undefined || v === null || v === '' ? null : parse(v, field);
}

export function parseCreateIssueCommand(v: unknown): CreateIssueCommand {
  const o = obj(v, 'command');
  return {
    projectId: id(o['projectId'], 'projectId'),
    businessDate: date(o['businessDate'], 'businessDate'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    title: text(o['title'], 'title', ISSUE_TITLE_MAX),
    category: category(o['category'], 'category'),
    escalate: bool(o['escalate'], 'escalate', false),
    controlled: bool(o['controlled'], 'controlled', false),
    workItemKey: optional(o['workItemKey'], key, 'workItemKey'),
    ownerPersonId: optional(o['ownerPersonId'], id, 'ownerPersonId'),
    dueOn: optional(o['dueOn'], date, 'dueOn'),
    note: str(o['note'] ?? '', 'note', ISSUE_TEXT_MAX).trim(),
  };
}
export function parseNoteIssueCommand(v: unknown): NoteIssueCommand {
  const o = obj(v, 'command');
  return {
    issueId: id(o['issueId'], 'issueId'),
    businessDate: date(o['businessDate'], 'businessDate'),
    expectedVersion: version(o['expectedVersion'], 'expectedVersion'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    text: text(o['text'], 'text', ISSUE_TEXT_MAX),
  };
}
export function parseSetEscalateCommand(v: unknown): SetEscalateCommand {
  const o = obj(v, 'command');
  if (typeof o['escalate'] !== 'boolean')
    throw new InvalidReportInput('escalate');
  return {
    issueId: id(o['issueId'], 'issueId'),
    expectedVersion: version(o['expectedVersion'], 'expectedVersion'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    escalate: o['escalate'],
    category: category(o['category'], 'category'),
  };
}
export function parseCloseIssueCommand(v: unknown): CloseIssueCommand {
  const o = obj(v, 'command');
  return {
    issueId: id(o['issueId'], 'issueId'),
    businessDate: date(o['businessDate'], 'businessDate'),
    expectedVersion: version(o['expectedVersion'], 'expectedVersion'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
  };
}
export const parseReopenIssueCommand: (v: unknown) => ReopenIssueCommand =
  parseCloseIssueCommand;
export function parseReplyIssueCommand(v: unknown): ReplyIssueCommand {
  const o = obj(v, 'command');
  return {
    issueId: id(o['issueId'], 'issueId'),
    businessDate: date(o['businessDate'], 'businessDate'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    text: text(o['text'], 'text', ISSUE_TEXT_MAX),
  };
}
export function parseDismissLagCommand(v: unknown): DismissLagCommand {
  const o = obj(v, 'command');
  return {
    projectId: id(o['projectId'], 'projectId'),
    businessDate: date(o['businessDate'], 'businessDate'),
    workItemKey: key(o['workItemKey'], 'workItemKey'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
  };
}
