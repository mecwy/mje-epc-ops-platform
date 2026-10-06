import { describe, expect, it } from 'vitest';
import { fillSectionForFocus } from './FillPage.js';

describe('completion reminders reveal the existing entry field', () => {
  it.each([
    ['q-support', 'progress'],
    ['c-support', 'progress'],
    ['ph-support', 'progress'],
    ['f-construction', 'progress'],
    ['p-manager', 'people'],
    ['m-rail', 'machinery'],
    ['mat-rail', 'materials'],
  ])('opens %s in %s without confusing shared item keys', (id, section) => {
    expect(fillSectionForFocus(id)).toBe(section);
  });
  it.each(['f-weather', 'f-quality', 'f-safety', 'unavailable-field'])(
    'keeps common/nonexistent %s outside business section navigation',
    (id) => {
      expect(fillSectionForFocus(id)).toBeNull();
    },
  );
});
