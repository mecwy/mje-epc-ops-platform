import { describe, expect, it } from 'vitest';
import { makeT } from '@mje/ui';
import { projectGroupTitle } from './overview-values.js';

describe('project grouping labels from authorized cards', () => {
  const personId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  it('uses the manager display name while retaining the natural-person grouping key', () => {
    const group = {
      key: personId,
      projects: [{ managers: [{ personId, displayName: 'TEST 经理甲' }] }],
    };
    expect(projectGroupTitle(makeT('zh'), 'manager', group)).toBe(
      'TEST 经理甲',
    );
    expect(group.key).toBe(personId);
  });
  it.each(['zh', 'en', 'sr', 'es'] as const)(
    'localizes unassigned groups in %s instead of showing the sentinel',
    (lang) => {
      const group = { key: '__UNASSIGNED__', projects: [] };
      const t = makeT(lang);
      expect(projectGroupTitle(t, 'region', group)).toBe(t('execNoRegion'));
      expect(projectGroupTitle(t, 'manager', group)).toBe(t('execUnassigned'));
      expect(projectGroupTitle(t, 'type', group)).toBe(t('execNoType'));
    },
  );
  it('finds the matching manager rather than another manager on the same card', () => {
    const group = {
      key: personId,
      projects: [
        {
          managers: [
            { personId: 'other', displayName: 'TEST other' },
            { personId, displayName: 'TEST correct' },
          ],
        },
      ],
    };
    expect(projectGroupTitle(makeT('zh'), 'manager', group)).toBe(
      'TEST correct',
    );
  });
  it('does not fall back to a UUID when a manager name is missing', () => {
    expect(
      projectGroupTitle(makeT('zh'), 'manager', {
        key: personId,
        projects: [],
      }),
    ).toBe(makeT('zh')('unknown'));
  });
  it('retains authored region and type names', () => {
    const group = { key: 'TEST 区域甲', projects: [] };
    expect(projectGroupTitle(makeT('zh'), 'region', group)).toBe(group.key);
    expect(projectGroupTitle(makeT('zh'), 'type', group)).toBe(group.key);
  });
});
