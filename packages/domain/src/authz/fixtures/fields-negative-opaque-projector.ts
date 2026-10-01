// Compile fixture (fields-typing.test.ts): must NOT type-check. A nested opaque value listed
// without a projector.
import type { FieldTable } from '../fields.js';

interface Dto {
  wrapped: { inner: Record<string, unknown>; label: string };
}
export const bad: FieldTable<Dto> = {
  wrapped: {
    layer: 'submitted',
    fields: {
      inner: { layer: 'submitted' }, // NEGATIVE
      label: { layer: 'public-text' },
    },
  },
};
