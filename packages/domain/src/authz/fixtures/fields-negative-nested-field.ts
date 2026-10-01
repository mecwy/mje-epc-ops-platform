// Compile fixture (fields-typing.test.ts): must NOT type-check. An object container classified
// by a bare layer: its nested fields are unregistered.
import type { FieldTable } from '../fields.js';

interface Dto {
  nested: { title: string; meta: { at: string } };
}
export const bad: FieldTable<Dto> = {
  nested: { layer: 'public-text' }, // NEGATIVE
};
