// Compile fixture (fields-typing.test.ts): must NOT type-check. Listing the fields of a union
// must cover every member's keys: the branch-only opaque `payload` is missing.
import type { FieldTable } from '../fields.js';

type Body =
  | { kind: 'plain'; text: string }
  | { kind: 'raw'; payload: Record<string, unknown> };
interface Dto {
  body: Body;
}
export const bad: FieldTable<Dto> = {
  body: {
    layer: 'submitted',
    fields: { kind: { layer: 'structure' }, text: { layer: 'public-text' } }, // NEGATIVE
  },
};
