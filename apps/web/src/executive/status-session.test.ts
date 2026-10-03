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

  it.each(['STATUS_FIELDS_REQUIRED', 'VERSION_CONFLICT'])(
    'keeps all input and the original version after %s and its newer reread',
    async (code) => {
      let currentN = 0;
      const sent: DeclareStatusCommand[] = [];
      const api = {
        projectStatus: async (projectId: string) =>
          history(projectId, currentN),
        declareProjectStatus: async (command: DeclareStatusCommand) => {
          sent.push(structuredClone(command));
          currentN = 1;
          throw new ApiError(code, 409);
        },
      };
      const session = new ProjectStatusSession(api, A);
      await session.load();
      session.edit({
        status: 'AT_RISK',
        areas: ['SCHEDULE'],
        situation: 'TEST delay',
        recovery: 'TEST recovery',
        expectedRecoveryUnknown: true,
        needsSupport: true,
        supportNote: 'TEST access',
      });
      const typed = structuredClone(session.draft);
      await session.publish();
      expect(session.read.data?.currentN).toBe(1);
      expect(session.draft).toEqual(typed);
      expect(session.commands.owned).toBe(false);
      await session.load();
      expect(session.draft).toEqual(typed);
      await session.publish();
      expect(sent[1]).toMatchObject({
        expectedN: 0,
        situation: 'TEST delay',
        recovery: 'TEST recovery',
      });
    },
  );

  it.each(['abandon', 'retry'] as const)(
    'does not %s or release a command waiting for its pre-send freshness read',
    async (action) => {
      let stage: 'normal' | 'failed' | 'held' = 'normal';
      let resolveRead: ((value: ProjectStatusHistoryDto) => void) | undefined;
      let readCalls = 0;
      const sent: DeclareStatusCommand[] = [];
      const api = {
        projectStatus: async (projectId: string) => {
          readCalls++;
          if (stage === 'failed') throw new ApiError('NETWORK', 0);
          if (stage === 'held')
            return new Promise<ProjectStatusHistoryDto>((resolve) => {
              resolveRead = resolve;
            });
          return history(projectId, 0);
        },
        declareProjectStatus: async (command: DeclareStatusCommand) => {
          sent.push(structuredClone(command));
          if (sent.length === 1) {
            stage = 'failed';
            throw new ApiError('STATUS_FIELDS_REQUIRED', 400);
          }
          return { projectId: A, n: 1, statusUpdateId: 'TEST-status' };
        },
      };
      const session = new ProjectStatusSession(api, A);
      await session.load();
      session.edit({ situation: 'TEST first draft' });
      await session.publish();
      stage = 'held';
      session.edit({ situation: 'TEST next draft' });
      const publishing = session.publish();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(resolveRead).toBeTypeOf('function');
      expect(session.commands.owned).toBe(true);
      expect(session.commands.unresolved).toBeNull();
      expect(session.read.busy).toBe(false);
      const before = readCalls;
      const attempted = session[action]();
      await Promise.resolve();
      expect(session.commands.owned).toBe(true);
      expect(readCalls).toBe(before);
      expect(session.lastAttemptMayBeRecorded).toBe(false);
      stage = 'normal';
      resolveRead?.(history(A, 0));
      await publishing;
      await attempted;
      expect(sent).toHaveLength(2);
      expect(sent[1]?.situation).toBe('TEST next draft');
    },
  );
  it('keeps refused input through a later pre-send read failure and recovery refresh', async () => {
    let failRead = false;
    let currentN = 0;
    let writes = 0;
    const api = {
      projectStatus: async (projectId: string) => {
        if (failRead) throw new ApiError('NETWORK', 0);
        return history(projectId, currentN);
      },
      declareProjectStatus: async () => {
        writes++;
        currentN = 1;
        failRead = true;
        throw new ApiError('VERSION_CONFLICT', 409);
      },
    };
    const session = new ProjectStatusSession(api, A);
    await session.load();
    session.edit({ situation: 'TEST retained through failed recovery read' });
    const typed = structuredClone(session.draft);
    await session.publish();
    await session.publish();
    expect(writes).toBe(1);
    expect(session.read.error).toBe('STALE');
    failRead = false;
    await session.retry();
    expect(session.read.data?.currentN).toBe(1);
    expect(session.draft).toEqual(typed);
    expect(session.commands.owned).toBe(false);
  });
});
