// Compile fixture (fields-typing.test.ts): must type-check. Not part of the build.
import type { FieldTable } from '../fields.js';

type Body =
  | { kind: 'plain'; text: string }
  | { kind: 'raw'; payload: Record<string, unknown> };
interface Dto {
  body: Body;
  mixed: (string | { payload: Record<string, unknown> })[];
  id: string;
  tags: string[];
  nested: { title: string; meta: { at: string } };
  rows: { key: string; value: string | null }[];
  extra: Record<string, unknown>;
  wrapped: { inner: Record<string, unknown>; label: string };
}
export const ok: FieldTable<Dto> = {
  body: {
    layer: 'submitted',
    fields: {
      kind: { layer: 'structure' },
      text: { layer: 'public-text' },
      payload: { layer: 'submitted', projector: 'readerSnapshot' },
    },
  },
  mixed: {
    layer: 'submitted',
    items: { payload: { layer: 'submitted', projector: 'readerSnapshot' } },
  },
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
