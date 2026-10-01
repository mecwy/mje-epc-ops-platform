import { describe, it, expect } from 'vitest';
import {
  parseDeclareStatusCommand,
  parseAddStatusNoteCommand,
} from './project-status.js';
const project = '11111111-1111-4111-8111-111111111111';
const normal = {
  expectedN: 0,
  clientMutationId: '22222222-2222-4222-8222-222222222222',
  status: 'NORMAL',
  areas: [],
  situation: '',
  recovery: '',
  expectedRecoveryUnknown: false,
  needsSupport: false,
  supportNote: '',
};
describe('project status boundary', () => {
  it('never accepts client actor, org, role or server time and keeps text unchanged', () => {
    for (const field of [
      'orgId',
      'declaredBy',
      'declaredByPersonId',
      'role',
      'declaredAt',
      'businessDate',
      'projectId',
    ])
      expect(() =>
        parseDeclareStatusCommand({ ...normal, [field]: 'TEST fake' }, project),
      ).toThrow('Invalid field: command');
    const c = parseDeclareStatusCommand(
      { ...normal, situation: '  TEST original  ' },
      project,
    );
    expect(c.situation).toBe('  TEST original  ');
    expect(c.expectedRecoveryDate).toBe(null);
    expect(c.expectedRecoveryUnknown).toBe(false);
  });
  it('rejects impossible calendar dates, non-boolean unknown and non-integer sequence', () => {
    expect(() =>
      parseDeclareStatusCommand(
        { ...normal, expectedRecoveryDate: '2026-02-30' },
        project,
      ),
    ).toThrow();
    expect(() =>
      parseDeclareStatusCommand(
        { ...normal, expectedRecoveryUnknown: 'false' },
        project,
      ),
    ).toThrow();
    expect(() =>
      parseDeclareStatusCommand({ ...normal, expectedN: 0.5 }, project),
    ).toThrow();
    expect(() =>
      parseAddStatusNoteCommand(
        { clientMutationId: normal.clientMutationId, text: '  ' },
        project,
        1,
      ),
    ).toThrow();
    expect(() =>
      parseAddStatusNoteCommand(
        { clientMutationId: normal.clientMutationId, text: 'TEST' },
        project,
        0,
      ),
    ).toThrow();
  });
});
