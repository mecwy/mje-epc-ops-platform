/** A7-1b: project masters and append-only reporting calendars, not inferred site facts. */
import {
  InvalidReportInput,
  KEY,
  date,
  id,
  obj,
  str,
  version,
} from './parse.js';
export interface SetPrimaryWorkItemCommand {
  projectId: string;
  key: string;
  expectedVersion: number;
  clientMutationId: string;
}
export interface RegisterExpectationCommand {
  projectId: string;
  fromDate: string;
  toDate: string | null;
  workdays: number[];
  clientMutationId: string;
}
export interface PrimaryWorkItemResultDto {
  projectId: string;
  key: string;
  version: number;
}
export interface ReportingExpectationResultDto {
  projectId: string;
  expectationId: string;
  n: number;
  registeredAt: string;
}
function keys(o: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(o).some((k) => !allowed.includes(k)))
    throw new InvalidReportInput('command');
}
export function parseSetPrimaryWorkItemCommand(
  value: unknown,
  projectId: string,
): SetPrimaryWorkItemCommand {
  const o = obj(value, 'command');
  keys(o, ['key', 'expectedVersion', 'clientMutationId']);
  const key = str(o['key'], 'key', 64);
  if (!KEY.test(key)) throw new InvalidReportInput('key');
  return {
    projectId: id(projectId, 'projectId'),
    key,
    expectedVersion: version(o['expectedVersion'], 'expectedVersion'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
  };
}
export function parseRegisterExpectationCommand(
  value: unknown,
  projectId: string,
): RegisterExpectationCommand {
  const o = obj(value, 'command');
  keys(o, ['fromDate', 'toDate', 'workdays', 'clientMutationId']);
  const fromDate = date(o['fromDate'], 'fromDate');
  const toDate =
    o['toDate'] === null || o['toDate'] === undefined
      ? null
      : date(o['toDate'], 'toDate');
  if (toDate !== null && toDate < fromDate)
    throw new InvalidReportInput('toDate');
  const days = o['workdays'];
  if (
    !Array.isArray(days) ||
    days.length < 1 ||
    days.length > 7 ||
    days.some((d) => !Number.isInteger(d) || d < 1 || d > 7) ||
    new Set(days).size !== days.length
  )
    throw new InvalidReportInput('workdays');
  return {
    projectId: id(projectId, 'projectId'),
    fromDate,
    toDate,
    workdays: [...days],
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
  };
}
