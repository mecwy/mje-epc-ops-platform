// Compile fixture (fields-typing.test.ts): must NOT type-check. A discriminated union whose
// `raw` branch alone carries an opaque value cannot be one subtree layer.
import type { FieldTable } from '../fields.js';

type Body =
  | { kind: 'plain'; text: string }
  | { kind: 'raw'; payload: Record<string, unknown> };
interface Dto {
  body: Body;
}
export const bad: FieldTable<Dto> = {
  body: { subtree: 'submitted' }, // NEGATIVE
};
