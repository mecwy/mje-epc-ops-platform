import { describe, expect, it } from 'vitest';
import {
  countFinding,
  editableDeclaration,
  freshDeclaration,
} from './alpha-data.js';

describe('daily-report source presentation', () => {
  it('flags a declared total that conflicts with category figures without changing either value', () => {
    const declaration = freshDeclaration();
    declaration.reportedSections!.workforce = [
      {
        id: crypto.randomUUID(),
        category: 'TEST',
        role: 'A',
        count: { state: 'VALUE', value: '1' },
        scopeCandidate: '',
      },
      {
        id: crypto.randomUUID(),
        category: 'TEST',
        role: 'B',
        count: { state: 'VALUE', value: '2' },
        scopeCandidate: '',
      },
    ];
    declaration.reportedHeadcount = { state: 'VALUE', value: '2' };
    expect(countFinding(declaration)).toContain('3 与原报总计 2 不同');
    expect(declaration.reportedHeadcount.value).toBe('2');
    expect(declaration.reportedSections!.workforce[1]!.count.value).toBe('2');
  });

  it('opens an older flat declaration for editing without discarding its original work items', () => {
    const previous = freshDeclaration();
    previous.workItems = [
      {
        id: crypto.randomUUID(),
        area: 'TEST',
        description: 'TEST original',
        quantity: { state: 'BLANK', value: null },
        unit: '套',
      },
    ];
    delete previous.reportedSections;
    const editable = editableDeclaration(previous);
    expect(editable.workItems).toEqual(previous.workItems);
    expect(editable.reportedSections?.progress).toEqual([]);
    expect(previous.reportedSections).toBeUndefined();
  });
});
