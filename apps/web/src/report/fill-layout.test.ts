import { describe, expect, it, vi } from 'vitest';
import { fillSectionForFocus, resolveFillFocus } from './FillPage.js';

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

describe('entry focus request lifecycle', () => {
  it('drops an absent photo control after reveal so a later tab stays selected', () => {
    let section: Parameters<typeof resolveFillFocus>[1] = 'people';
    let request: string | null = 'ph-support';
    const reveal = vi.fn((next: typeof section) => {
      section = next;
    });
    const resolved = vi.fn(() => {
      request = null;
    });
    const runEffect = () => {
      if (request)
        resolveFillFocus(request, section, {
          reveal,
          find: () => null,
          resolved,
        });
    };
    runEffect();
    expect(section).toBe('progress');
    expect(resolved).not.toHaveBeenCalled();
    runEffect();
    expect(request).toBeNull();
    expect(resolved).toHaveBeenCalledOnce();
    section = 'materials';
    runEffect();
    expect(section).toBe('materials');
    expect(reveal).toHaveBeenCalledOnce();
  });

  it('reveals the hidden panel before resolving and focusing its existing input', () => {
    const steps: string[] = [];
    const ports = {
      reveal: () => steps.push('reveal'),
      find: () => {
        steps.push('find');
        return {
          scrollIntoView: () => steps.push('scroll'),
          focus: () => steps.push('focus'),
        };
      },
      resolved: () => steps.push('resolved'),
    };
    resolveFillFocus('mat-steel', 'progress', ports);
    expect(steps).toEqual(['reveal']);
    resolveFillFocus('mat-steel', 'materials', ports);
    expect(steps).toEqual(['reveal', 'find', 'scroll', 'focus', 'resolved']);
  });
});
