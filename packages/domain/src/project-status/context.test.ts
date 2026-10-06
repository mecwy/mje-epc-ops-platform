import { describe, it, expect } from 'vitest';
import type { PoolClient } from 'pg';
import type { Actor } from '../store-kit.js';
import {
  withProjectStatusReadContext,
  type ProjectStatusReadContext,
} from './context.js';
import { projectStatusReader } from './reader.js';
import { requiredStatusFields as contractRequiredStatusFields } from '@mje/contracts';
import { requiredStatusFields } from './rules.js';
const projectId = '11111111-1111-4111-8111-111111111111';
const ack = {
  projectId,
  n: 1,
  statusUpdateId: '22222222-2222-4222-8222-222222222222',
};
describe('project status opaque context', () => {
  it('shares the unchanged pure status validator with contract consumers', () => {
    expect(requiredStatusFields).toBe(contractRequiredStatusFields);
    const command = {
      projectId,
      expectedN: 0,
      clientMutationId: 'TEST-key',
      status: 'AT_RISK',
      areas: [],
      situation: '  ',
      recovery: '',
      expectedRecoveryDate: null,
      expectedRecoveryUnknown: false,
      needsSupport: false,
      supportNote: '',
    } as const;
    const input = { ...command, areas: [] };
    expect(requiredStatusFields(input)).toEqual([
      'areas',
      'situation',
      'recovery',
      'expectedRecoveryDate',
      'expectedRecoveryUnknown',
    ]);
    expect(input.situation).toBe('  ');
    expect(
      requiredStatusFields({
        ...input,
        areas: ['SCHEDULE'],
        situation: 'TEST delay',
        recovery: 'TEST plan',
        expectedRecoveryUnknown: true,
      }),
    ).toEqual([]);
  });
  it('reads only the restricted manager projection through the module exit', async () => {
    const rows = [
      {
        projectId,
        personId: '33333333-3333-4333-8333-333333333333',
        displayName: 'TEST Manager',
      },
    ];
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows };
      },
    } as unknown as PoolClient;
    await withProjectStatusReadContext(client, {} as Actor, async (ctx) => {
      const projected = await projectStatusReader
        .forContext(ctx)
        .managerProjections();
      expect(projected).toEqual(rows);
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('project_managers_for_org()');
    expect(queries[0]).not.toContain('Membership');
  });

  it('refuses forged and copied contexts before any query and closes a kept view', async () => {
    let calls = 0;
    const client = {
      query: () => {
        calls++;
        throw new Error('unexpected SQL');
      },
    } as unknown as PoolClient;
    let kept: ReturnType<typeof projectStatusReader.forContext> | undefined;
    await withProjectStatusReadContext(client, {} as Actor, async (ctx) => {
      expect(Object.keys(ctx)).toEqual([]);
      expect(Object.isFrozen(ctx)).toBe(true);
      const view = projectStatusReader.forContext(ctx);
      expect(view.acknowledgement(projectId, ack)).toEqual(ack);
      kept = view;
      const copy = { ...ctx } as ProjectStatusReadContext;
      await expect(
        projectStatusReader.forContext(copy).history(projectId),
      ).rejects.toThrow('PROJECT_STATUS_CONTEXT_CLOSED');
      expect(() =>
        view.acknowledgement('33333333-3333-4333-8333-333333333333', ack),
      ).toThrow('NOT_FOUND');
    });
    await expect(kept!.history(projectId)).rejects.toThrow(
      'PROJECT_STATUS_CONTEXT_CLOSED',
    );
    expect(() => kept!.acknowledgement(projectId, ack)).toThrow(
      'PROJECT_STATUS_CONTEXT_CLOSED',
    );
    expect(calls).toBe(0);
    await expect(
      projectStatusReader
        .forContext({} as ProjectStatusReadContext)
        .history(projectId),
    ).rejects.toThrow('PROJECT_STATUS_CONTEXT_CLOSED');
  });
});
