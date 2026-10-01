// Compile fixture (fields-typing.test.ts): must NOT type-check. A whole-subtree layer over a
// value with an opaque descendant: the opaque value would escape its projector.
import type { FieldTable } from '../fields.js';

interface Dto {
  wrapped: { inner: Record<string, unknown>; label: string };
}
export const bad: FieldTable<Dto> = {
  wrapped: { subtree: 'submitted' }, // NEGATIVE
};
