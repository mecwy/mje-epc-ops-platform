/**
 * The context a report read runs in (ADR-0003 D1, transition form): built by the server inside
 * the read transaction from the verified identity and its memberships (store-kit inTransaction),
 * never from anything the client sent. Opaque outside the report module: only the exit
 * (report-reader.ts) can open it. A7-0b adds the authorization version and the account lock;
 * callers do not change.
 */
import type { PoolClient } from 'pg';
import type { Actor } from './store-kit.js';

const OPEN = Symbol('reportReadContext');
export interface ReportReadContext {
  readonly [OPEN]: { readonly client: PoolClient; readonly actor: Actor };
}
/** Only for code that already holds a transaction opened by inTransaction for this actor. */
export function reportReadContext(
  client: PoolClient,
  actor: Actor,
): ReportReadContext {
  return { [OPEN]: { client, actor } };
}
export function openReportReadContext(ctx: ReportReadContext) {
  return ctx[OPEN];
}
