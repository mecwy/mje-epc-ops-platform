// Compile fixture (fields-typing.test.ts): must NOT type-check. An array whose elements are
// opaque needs a projector; an empty item table classifies nothing.
import type { FieldTable } from '../fields.js';

interface Dto {
  rows: Record<string, unknown>[];
}
export const bad: FieldTable<Dto> = {
  rows: { layer: 'submitted', items: {} }, // NEGATIVE
};
