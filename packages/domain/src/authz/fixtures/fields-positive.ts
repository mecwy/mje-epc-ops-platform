// Compile fixture (fields-typing.test.ts): must type-check. Not part of the build.
import type { FieldTable } from '../fields.js';

interface Dto {
  id: string;
  tags: string[];
  nested: { title: string; meta: { at: string } };
  rows: { key: string; value: string | null }[];
  extra: Record<string, unknown>;
  wrapped: { inner: Record<string, unknown>; label: string };
}
export const ok: FieldTable<Dto> = {
  id: { layer: 'structure' },
  tags: { layer: 'structure' },
  nested: { subtree: 'public-text' },
  rows: {
    layer: 'submitted',
    items: { key: { layer: 'structure' }, value: { layer: 'submitted' } },
  },
  extra: { layer: 'submitted', projector: 'readerSnapshot' },
  wrapped: {
    layer: 'submitted',
    fields: {
      inner: { layer: 'submitted', projector: 'readerSnapshot' },
      label: { layer: 'public-text' },
    },
  },
};
