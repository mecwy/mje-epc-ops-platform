/** Transaction-local, opaque read context. Raw actor/client never leave this module. */
import type { PoolClient } from 'pg';
import type { Actor } from '../store-kit.js';
declare const brand: unique symbol;
export interface ProjectStatusReadContext {
  readonly [brand]: 'ProjectStatusReadContext';
}
const live = new WeakMap<object, { client: PoolClient; actor: Actor }>();
export async function withProjectStatusReadContext<T>(
  client: PoolClient,
  actor: Actor,
  use: (ctx: ProjectStatusReadContext) => Promise<T>,
): Promise<T> {
  const ctx = Object.freeze(Object.create(null)) as ProjectStatusReadContext;
  const guarded = Object.create(client, {
    query: {
      value: (...args: Parameters<PoolClient['query']>) => {
        openProjectStatusReadContext(ctx);
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
export function openProjectStatusReadContext(ctx: ProjectStatusReadContext) {
  const state =
    typeof ctx === 'object' && ctx !== null ? live.get(ctx) : undefined;
  if (!state) throw new Error('PROJECT_STATUS_CONTEXT_CLOSED');
  return state;
}
