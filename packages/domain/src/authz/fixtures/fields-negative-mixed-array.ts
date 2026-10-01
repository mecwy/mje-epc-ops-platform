// Compile fixture (fields-typing.test.ts): must NOT type-check. An array mixing primitives and
// opaque-bearing objects is not a primitive array: a bare layer does not classify its items.
import type { FieldTable } from '../fields.js';

interface Dto {
  rows: (string | { payload: Record<string, unknown> })[];
}
export const bad: FieldTable<Dto> = {
  rows: { layer: 'submitted' }, // NEGATIVE
};
