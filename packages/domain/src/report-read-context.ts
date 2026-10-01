/**
 * The context a report read runs in (ADR-0003 D1, transition form): built by the server inside
 * the read transaction from the verified identity and its memberships (store-kit inTransaction),
 * never from anything the client sent. Opaque at run time: the client and actor live in a
 * module-private WeakMap, so a context carries no recoverable fields and a forged or copied
 * object is refused. It is valid only while its transaction runs: `withReportReadContext` ends
 * it before the transaction commits or rolls back, and the client a read gets is guarded: every
 * query checks that the context is still live. So a context, a view kept past its transaction,
 * or a call still in flight when the callback returned cannot run a query after COMMIT or on a
 * released (possibly reused) client; it fails with REPORT_READ_CONTEXT_CLOSED. The transaction
 * does not wait for such calls.
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
  const closed = () => new Error('REPORT_READ_CONTEXT_CLOSED');
  // Every statement passes this check, including those of a call started before the context
  // ended; a statement already sent before COMMIT was queued still completes before COMMIT.
  const guarded = Object.create(client, {
    query: {
      value: (...args: Parameters<PoolClient['query']>) => {
        if (!live.has(ctx)) throw closed();
        return Reflect.apply(client.query, client, args);
      },
    },
  }) as PoolClient;
  live.set(ctx, { client: guarded, actor });
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
