/** A7-1a: manager declarations and project-visible replies; no approval or verification. */
import { InvalidReportInput, date, id, obj, oneOf, str } from './parse.js';
export const PROJECT_STATUSES = [
  'NORMAL',
  'AT_RISK',
  'OFF_TRACK',
  'PAUSED',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const STATUS_AREAS = [
  'SCHEDULE',
  'RESOURCE',
  'SAFETY',
  'QUALITY',
  'EXTERNAL',
] as const;
export type StatusArea = (typeof STATUS_AREAS)[number];
export const STATUS_FIELD_NAMES = [
  'areas',
  'situation',
  'recovery',
  'expectedRecoveryDate',
  'expectedRecoveryUnknown',
  'needsSupport',
  'supportNote',
] as const;
export type StatusFieldName = (typeof STATUS_FIELD_NAMES)[number];
export interface DeclareStatusCommand {
  projectId: string;
  expectedN: number;
  clientMutationId: string;
  status: ProjectStatus;
  areas: StatusArea[];
  situation: string;
  recovery: string;
  expectedRecoveryDate: string | null;
  expectedRecoveryUnknown: boolean;
  needsSupport: boolean;
  supportNote: string;
}
export interface AddStatusNoteCommand {
  projectId: string;
  n: number;
  clientMutationId: string;
  text: string;
}
export interface StatusNoteDto {
  id: string;
  text: string;
  byAccountId: string;
  byPersonId: string;
  at: string;
}
export interface StatusUpdateDto {
  id: string;
  n: number;
  status: ProjectStatus;
  areas: StatusArea[];
  situation: string;
  recovery: string;
  expectedRecoveryDate: string | null;
  expectedRecoveryUnknown: boolean;
  needsSupport: boolean;
  supportNote: string;
  declaredAt: string;
  siteTimezone: string;
  businessDate: string;
  declaredBy: string;
  declaredByPersonId: string;
  notes: StatusNoteDto[];
}
export interface ProjectStatusHistoryDto {
  projectId: string;
  currentN: number;
  updates: StatusUpdateDto[];
}
export interface StatusCommandResultDto {
  projectId: string;
  n: number;
  statusUpdateId: string;
  noteId?: string;
}
function keys(o: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(o).some((k) => !allowed.includes(k)))
    throw new InvalidReportInput('command');
}
function bool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new InvalidReportInput(field);
  return v;
}
export function statusSequence(v: unknown, field = 'n'): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 2147483647)
    throw new InvalidReportInput(field);
  return v;
}
export function parseDeclareStatusCommand(
  value: unknown,
  projectId: string,
): DeclareStatusCommand {
  const o = obj(value, 'command');
  keys(o, [
    'expectedN',
    'clientMutationId',
    'status',
    'areas',
    'situation',
    'recovery',
    'expectedRecoveryDate',
    'expectedRecoveryUnknown',
    'needsSupport',
    'supportNote',
  ]);
  if (!Array.isArray(o['areas'])) throw new InvalidReportInput('areas');
  return {
    projectId: id(projectId, 'projectId'),
    expectedN: statusSequence(o['expectedN'], 'expectedN'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    status: oneOf(o['status'], PROJECT_STATUSES, 'status'),
    areas: o['areas'].map((a) => oneOf(a, STATUS_AREAS, 'areas')),
    situation: str(o['situation'], 'situation'),
    recovery: str(o['recovery'], 'recovery'),
    expectedRecoveryDate:
      o['expectedRecoveryDate'] === undefined ||
      o['expectedRecoveryDate'] === null
        ? null
        : date(o['expectedRecoveryDate'], 'expectedRecoveryDate'),
    expectedRecoveryUnknown: bool(
      o['expectedRecoveryUnknown'],
      'expectedRecoveryUnknown',
    ),
    needsSupport: bool(o['needsSupport'], 'needsSupport'),
    supportNote: str(o['supportNote'], 'supportNote'),
  };
}
export function parseAddStatusNoteCommand(
  value: unknown,
  projectId: string,
  n: number,
): AddStatusNoteCommand {
  const o = obj(value, 'command');
  keys(o, ['clientMutationId', 'text']);
  const number = statusSequence(n);
  if (number === 0) throw new InvalidReportInput('n');
  const text = str(o['text'], 'text');
  if (!text.trim()) throw new InvalidReportInput('text');
  return {
    projectId: id(projectId, 'projectId'),
    n: number,
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    text,
  };
}
