/**
 * ADR-0003 D6 minimal interpreter: from surface.ts and fields.ts alone, decide for a TEST
 * context whether an entry is allowed and which field paths its response may carry. Shares no
 * code with production authorization (store-kit projectAccess, the report exit); anchors.test.ts
 * pins it with hand-written fixtures.
 */
import { FIELDS, type Layer, type ProjectorDtos } from './fields.js';
import type { Capability, Principal, SurfaceEntry } from './surface.js';

export interface TestContext {
  principal: Principal;
  capabilities: Capability[];
  /** Where the target lies relative to the context's grants. */
  scope: 'granted' | 'other-project' | 'other-org';
}
export interface Decision {
  allowed: boolean;
  capability: Capability | null;
  /** Field paths (`a.b`, `rows[].c`) the response may carry; [] when denied or unlayered. */
  visibleKeys: string[];
}

interface Spec {
  layer?: Layer;
  subtree?: Layer;
  fields?: Record<string, Spec>;
  items?: Record<string, Spec>;
}
function paths(
  table: Record<string, Spec>,
  layers: Layer[],
  prefix: string,
): string[] {
  return Object.entries(table).flatMap(([key, spec]) => {
    const layer = spec.layer ?? spec.subtree;
    if (layer && !layers.includes(layer)) return [];
    const here = `${prefix}${key}`;
    if (spec.fields) return [here, ...paths(spec.fields, layers, `${here}.`)];
    if (spec.items) return [here, ...paths(spec.items, layers, `${here}[].`)];
    return [here];
  });
}

export function decide(entry: SurfaceEntry, ctx: TestContext): Decision {
  if (entry.direction !== 'n/a')
    throw new Error('EXPLICIT_GRANT_CONTEXT_REQUIRED');
  const denied = { allowed: false, capability: null, visibleKeys: [] };
  if (entry.principal !== ctx.principal) return denied;
  const capability = entry.capability.find((c) => ctx.capabilities.includes(c));
  if (!capability) return denied;
  // Membership-scoped entries list only what the grants cover; others need the target in scope.
  if (
    ctx.scope !== 'granted' &&
    !['membership', 'none'].includes(entry.scopeSource)
  )
    return denied;
  const projector = entry.projector?.[capability];
  const layers = entry.layers[capability] ?? [];
  if (!projector || !(projector in FIELDS))
    return { allowed: true, capability, visibleKeys: [] };
  const root = FIELDS[projector as keyof ProjectorDtos] as unknown as Spec;
  const visibleKeys = root.fields
    ? paths(root.fields, layers, '')
    : paths(root.items ?? {}, layers, '[].');
  return { allowed: true, capability, visibleKeys };
}
