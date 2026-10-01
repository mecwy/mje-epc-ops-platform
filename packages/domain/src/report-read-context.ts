/**
 * The context a report read runs in (ADR-0003 D1, transition form): built by the server inside
 * the read transaction from the verified identity and its memberships (store-kit inTransaction),
 * never from anything the client sent. Opaque at run time: the client and actor live in a
 * module-private WeakMap, so a context carries no recoverable fields and a forged or copied
 * object is refused. It is valid only while its transaction runs: `withReportReadContext` ends
 * it before the transaction commits or rolls back, and every read checks it again, so a context
 * or view kept past its transaction cannot reach a released (possibly reused) client.
 * A7-0b adds the authorization version and the account lock; callers do not change.
 */
import type { PoolClient } from 'pg';
import type { Actor } from './store-kit.js';

declare const brand: unique symbol;
export interface ReportReadContext {
  readonly [brand]: 'ReportReadContext';
}
interface Open {
  readonly client: PoolClient;
  readonly actor: Actor;
}
const live = new WeakMap<object, Open>();

/**
 * Runs `use` with a context for the caller's open transaction (client, actor as resolved by
 * inTransaction) and ends the context when `use` settles, before the transaction completes.
 */
export async function withReportReadContext<T>(
  client: PoolClient,
  actor: Actor,
  use: (ctx: ReportReadContext) => Promise<T>,
): Promise<T> {
  const ctx = Object.freeze(Object.create(null)) as ReportReadContext;
  live.set(ctx, { client, actor });
  try {
    return await use(ctx);
  } finally {
    live.delete(ctx);
  }
}
/** Report module only (report-reader.ts): the transaction behind a live context. */
export function openReportReadContext(ctx: ReportReadContext): Open {
  const open =
    typeof ctx === 'object' && ctx !== null ? live.get(ctx) : undefined;
  if (!open) throw new Error('REPORT_READ_CONTEXT_CLOSED');
  return open;
}
