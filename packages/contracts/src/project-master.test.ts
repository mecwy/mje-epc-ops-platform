import { describe, it, expect } from 'vitest';
import {
  parseRegisterExpectationCommand,
  parseSetPrimaryWorkItemCommand,
} from './project-master.js';
import { parseSaveItemsCommand } from './report.js';
const project = '00000000-0000-4000-8000-000000000001',
  key = '00000000-0000-4000-8000-000000000002';
const calendar = {
  fromDate: '2030-01-01',
  workdays: [1, 3, 7],
  clientMutationId: key,
};
describe('project masters', () => {
  it('preserves registered weekday order and never accepts injected authority/time', () => {
    expect(parseRegisterExpectationCommand(calendar, project)).toEqual({
      ...calendar,
      projectId: project,
      toDate: null,
    });
    for (const patch of [
      { orgId: project },
      { registeredAt: '2030-01-01T00:00:00Z' },
      { fromDate: '2030-02-30' },
      { toDate: '2029-12-31' },
      { workdays: [] },
      { workdays: [1, 1] },
      { workdays: [0] },
      { workdays: [8] },
      { workdays: ['1'] },
      { workdays: [1.5] },
    ])
      expect(() =>
        parseRegisterExpectationCommand({ ...calendar, ...patch }, project),
      ).toThrow();
    expect(() =>
      parseSetPrimaryWorkItemCommand(
        {
          key: 'work-1',
          expectedVersion: 1,
          clientMutationId: key,
          actor: project,
        },
        project,
      ),
    ).toThrow();
  });
  it('milestone constraints and date omission vs explicit clearing', () => {
    const item = {
      kind: 'milestone',
      key: 'node',
      label: 'TEST node',
      unit: '',
      designQty: '',
      openingCumulative: '',
      sortOrder: 0,
      active: true,
    };
    const parse = (patch: object) =>
      parseSaveItemsCommand({
        projectId: project,
        items: [{ ...item, ...patch }],
        clientMutationId: key,
      });
    expect(parse({}).items[0]).not.toHaveProperty('plannedDate');
    expect(parse({ plannedDate: null }).items[0]!.plannedDate).toBeNull();
    expect(parse({ plannedDate: '2030-01-02' }).items[0]!.plannedDate).toBe(
      '2030-01-02',
    );
    for (const patch of [
      { unit: 'm' },
      { designQty: '0' },
      { plannedDate: '2030-02-30' },
    ])
      expect(() => parse(patch)).toThrow();
  });
});
