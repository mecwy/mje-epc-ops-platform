import { describe, expect, it } from 'vitest';
import {
  InvalidReportInput,
  encodeDeviceCursor,
  parseDeviceListQuery,
  fieldBearer,
  parseBindCommand,
  parseChallengeConfirmCommand,
  parseCreateCrewCommand,
  parseEntryCommand,
  parseRosterChangesCommand,
  parseRotateCommand,
} from './index.js';

const token = 'fd1.' + 'A'.repeat(42) + '_';
const code = 'abcdefghij_-KLMNOPQRST';
const id = '4f7c1a52-3d7e-4c21-9e1a-2b3c4d5e6f70';

describe('field credentials', () => {
  it('only a well-formed Bearer fd1 header is a field credential', () => {
    expect(fieldBearer(`Bearer ${token}`)).toBe(token);
    for (const bad of [
      undefined,
      token,
      `bearer ${token}`,
      `Bearer ${token}x`,
      `Bearer fd2.${'A'.repeat(43)}`,
      'Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig',
      `Bearer ${token} `,
    ])
      expect(fieldBearer(bad)).toBeNull();
  });
  it('entry and bind take a 128-bit code; bind a device-made token', () => {
    expect(parseEntryCommand({ code })).toEqual({ code });
    expect(() => parseEntryCommand({ code: code.slice(1) })).toThrow(
      InvalidReportInput,
    );
    expect(
      parseBindCommand({ code, personId: id.toUpperCase(), token }),
    ).toEqual({ code, personId: id, token });
    expect(() =>
      parseBindCommand({ code, personId: id, token: 'fd1.x' }),
    ).toThrow(InvalidReportInput);
    expect(() =>
      parseRotateCommand({ newToken: token, expectedGeneration: -1 }),
    ).toThrow(InvalidReportInput);
  });
  it('a rejected token is never echoed in the error', () => {
    try {
      parseBindCommand({ code, personId: id, token: 'fd1.SECRET' });
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('SECRET');
    }
  });
  it('confirm needs an explicit expectedCurrentDeviceId (null = none) and a 6-digit code', () => {
    const base = { clientMutationId: id, personId: id, code: '012345' };
    expect(() => parseChallengeConfirmCommand(base)).toThrow(
      InvalidReportInput,
    );
    expect(
      parseChallengeConfirmCommand({ ...base, expectedCurrentDeviceId: null })
        .expectedCurrentDeviceId,
    ).toBeNull();
    expect(() =>
      parseChallengeConfirmCommand({
        ...base,
        code: '12345',
        expectedCurrentDeviceId: null,
      }),
    ).toThrow(InvalidReportInput);
  });
});

describe('roster commands', () => {
  const base = {
    projectId: id,
    clientMutationId: id,
    expectedRosterVersion: 0,
  };
  it('crew code and name are bounded', () => {
    expect(
      parseCreateCrewCommand({ ...base, code: 'C-1', name: ' A ' }).name,
    ).toBe('A');
    expect(() =>
      parseCreateCrewCommand({ ...base, code: '-x', name: 'A' }),
    ).toThrow(InvalidReportInput);
  });
  it('changes are opens and closes; times are instants or now', () => {
    const cmd = parseRosterChangesCommand({
      ...base,
      changes: [
        { op: 'close', assignmentId: id, at: '2026-10-05T12:00:00Z' },
        { op: 'open', crewId: id, personId: id, role: 'MEMBER', from: null },
      ],
    });
    expect(cmd.changes).toEqual([
      { op: 'close', assignmentId: id, at: '2026-10-05T12:00:00Z' },
      { op: 'open', crewId: id, personId: id, role: 'MEMBER', from: null },
    ]);
    for (const changes of [
      [],
      [{ op: 'open', crewId: id, personId: id, role: 'BOSS' }],
      [{ op: 'close', assignmentId: id, at: '2026-02-30T00:00:00Z' }],
      [
        { op: 'close', assignmentId: id },
        { op: 'close', assignmentId: id },
      ],
    ])
      expect(() => parseRosterChangesCommand({ ...base, changes })).toThrow(
        InvalidReportInput,
      );
  });
});

describe('PM device list query', () => {
  const projectId = '4f7c1a52-3d7e-4c21-9e1a-2b3c4d5e6f70';
  const deviceId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
  it('accepts real edge instants: a leap day and the last microsecond of a day', () => {
    for (const t of [
      '2028-02-29T00:00:00.000000Z',
      '2026-12-31T23:59:59.999999Z',
    ])
      expect(
        parseDeviceListQuery({
          projectId,
          cursor: encodeDeviceCursor(t, deviceId),
          limit: undefined,
        }).after,
      ).toEqual({ createdAt: t, id: deviceId });
  });
  it('round-trips a cursor at microsecond precision and bounds the page size', () => {
    const cursor = encodeDeviceCursor('2026-09-30T01:02:03.123456Z', deviceId);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseDeviceListQuery({ projectId, cursor, limit: '500' })).toEqual({
      projectId,
      after: { createdAt: '2026-09-30T01:02:03.123456Z', id: deviceId },
      limit: 500,
    });
    expect(
      parseDeviceListQuery({ projectId, cursor: undefined, limit: undefined }),
    ).toEqual({ projectId, after: null, limit: 200 });
    for (const limit of ['0', '501', '-1', '1.5', 'x'])
      expect(() =>
        parseDeviceListQuery({ projectId, cursor: undefined, limit }),
      ).toThrow(InvalidReportInput);
  });
  it('refuses a malformed or tampered cursor', () => {
    for (const cursor of [
      'not-a-cursor',
      encodeDeviceCursor('2026-09-30T01:02:03Z', deviceId),
      // impossible calendar dates and clock times, with a valid six-digit fraction
      encodeDeviceCursor('2026-02-30T01:02:03.123456Z', deviceId),
      encodeDeviceCursor('2026-13-01T01:02:03.123456Z', deviceId),
      encodeDeviceCursor('2026-09-30T24:00:00.000000Z', deviceId),
      encodeDeviceCursor('2026-09-30T23:60:00.000000Z', deviceId),
      encodeDeviceCursor('2026-09-30T23:59:60.000000Z', deviceId),
      encodeDeviceCursor('2026-09-30T01:02:03.123456Z', 'x'),
      encodeDeviceCursor('2026-09-30T01:02:03.123456Z', `${deviceId}|x`),
      '%%%',
    ])
      expect(() =>
        parseDeviceListQuery({ projectId, cursor, limit: undefined }),
      ).toThrow(InvalidReportInput);
  });
});
