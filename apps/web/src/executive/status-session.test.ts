import { describe, expect, it } from 'vitest';
import type {
  DeclareStatusCommand,
  ProjectStatusHistoryDto,
  StatusCommandResultDto,
} from '@mje/contracts';
import type { ReportApi } from '../api.js';
import { ApiError } from '../api.js';
import { ProjectStatusSession } from './status-session.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function history(projectId: string, currentN: number): ProjectStatusHistoryDto {
  return { projectId, currentN, updates: [] };
}

describe('ProjectStatusSession', () => {
  it('keeps the edited project and expected version when a newer read lands', async () => {
    let currentN = 0;
    const sent: DeclareStatusCommand[] = [];
    const api = {
      projectStatus: async (projectId: string) => history(projectId, currentN),
      declareProjectStatus: async (command: DeclareStatusCommand) => {
        sent.push(command);
        currentN = 2;
        return {
          projectId: command.projectId,
          n: currentN,
          statusUpdateId: 'status-update',
        } satisfies StatusCommandResultDto;
      },
    } as Pick<ReportApi, 'projectStatus' | 'declareProjectStatus'>;
    const session = new ProjectStatusSession(api, A);
    await session.load();
    session.edit({ status: 'AT_RISK', areas: ['SCHEDULE'] });
    currentN = 1;
    await session.load();
    await session.publish();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      projectId: A,
      expectedN: 0,
      status: 'AT_RISK',
      areas: ['SCHEDULE'],
    });
    expect(sent[0]?.clientMutationId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('retains an unknown declaration as the same project, version and payload for retry', async () => {
    const sent: DeclareStatusCommand[] = [];
    let attempt = 0;
    let currentN = 0;
    const api = {
      projectStatus: async (projectId: string) => history(projectId, currentN),
      declareProjectStatus: async (command: DeclareStatusCommand) => {
        sent.push(structuredClone(command));
        if (attempt++ === 0) throw new ApiError('NETWORK', 0);
        currentN = 1;
        return {
          projectId: command.projectId,
          n: currentN,
          statusUpdateId: 'status-update',
        } satisfies StatusCommandResultDto;
      },
    } as Pick<ReportApi, 'projectStatus' | 'declareProjectStatus'>;
    const session = new ProjectStatusSession(api, A);
    await session.load();
    session.edit({
      status: 'OFF_TRACK',
      areas: ['RESOURCE'],
      situation: 'Crew access blocked',
      recovery: 'Restore gate access',
      expectedRecoveryUnknown: true,
    });
    await session.publish();
    expect(session.commands.unresolved).not.toBeNull();

    await session.retry();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(session.commands.owned).toBe(false);
    expect(session.read.data?.currentN).toBe(1);
  });
});
