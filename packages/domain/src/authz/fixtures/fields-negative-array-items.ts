// Compile fixture (fields-typing.test.ts): must NOT type-check. An array of objects whose
// items are not classified.
import type { FieldTable } from '../fields.js';

interface Dto {
  rows: { key: string; value: string | null }[];
}
export const bad: FieldTable<Dto> = {
  rows: { layer: 'submitted' }, // NEGATIVE
};
