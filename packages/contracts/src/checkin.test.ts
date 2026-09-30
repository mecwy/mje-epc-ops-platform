import { describe, expect, it } from 'vitest';
import {
  InvalidReportInput,
  parseCheckInCommand,
  parseFieldSettingsCommand,
  parsePmProxyCheckInCommand,
  parseSelfieUploadCommand,
  parseSiteReferenceCommand,
  parseVoidCheckInCommand,
} from './index.js';

const id = '4f7c1a52-3d7e-4c21-9e1a-2b3c4d5e6f70';
const fix = {
  lat: '0.000000',
  lon: '0.000000',
  accuracyM: '12.5',
  fixAt: '2026-10-05T07:59:50Z',
};
const checkIn = {
  clientMutationId: id,
  businessDate: '2026-10-05',
  occurredAt: '2026-10-05T08:00:00Z',
  fix,
  stagedSelfieId: null,
  deviceSentAt: '2026-10-05T08:00:01Z',
};

describe('check-in contracts', () => {
  it('parses a self check-in; a missing selfie is null', () => {
    expect(parseCheckInCommand(checkIn)).toEqual(checkIn);
    const { stagedSelfieId: _unused, ...noSelfie } = checkIn;
    void _unused;
    expect(parseCheckInCommand(noSelfie).stagedSelfieId).toBeNull();
  });
  it('refuses NaN, out-of-range and malformed coordinates, accuracy and times', () => {
    for (const bad of [
      { lat: 'NaN' },
      { lat: '90.000001' },
      { lon: '-180.5' },
      { lon: '1e3' },
      { accuracyM: '-1' },
      { accuracyM: 'NaN' },
      { fixAt: '2026-02-30T00:00:00Z' },
      { lat: 0 },
    ])
      expect(() =>
        parseCheckInCommand({ ...checkIn, fix: { ...fix, ...bad } }),
      ).toThrow(InvalidReportInput);
    expect(() =>
      parseCheckInCommand({ ...checkIn, deviceSentAt: 'yesterday' }),
    ).toThrow(InvalidReportInput);
    expect(() => parseCheckInCommand({ ...checkIn, fix: null })).toThrow(
      InvalidReportInput,
    );
  });
  it('a PM proxy without a time stays without one (DAY precision); source is required', () => {
    const cmd = parsePmProxyCheckInCommand({
      projectId: id,
      clientMutationId: id,
      personId: id,
      businessDate: '2026-10-05',
      source: 'FOREMAN_REPORTED',
      reason: '  TEST  ',
    });
    expect(cmd.occurredAt).toBeNull();
    expect(cmd.actorFix).toBeNull();
    expect(cmd.reason).toBe('TEST');
    expect(() =>
      parsePmProxyCheckInCommand({ ...cmd, source: 'GUESS' }),
    ).toThrow(InvalidReportInput);
  });
  it('void needs a reason; settings bound the radius and the proxy window', () => {
    expect(() =>
      parseVoidCheckInCommand({
        projectId: id,
        clientMutationId: id,
        checkInId: id,
        reason: '   ',
      }),
    ).toThrow(InvalidReportInput);
    const ref = {
      projectId: id,
      clientMutationId: id,
      expectedN: 0,
      lat: '0.000000',
      lon: '0.000000',
      radiusM: 500,
    };
    expect(parseSiteReferenceCommand(ref).radiusM).toBe(500);
    for (const radiusM of [49, 2001, 500.5])
      expect(() => parseSiteReferenceCommand({ ...ref, radiusM })).toThrow(
        InvalidReportInput,
      );
    const settings = {
      projectId: id,
      clientMutationId: id,
      expectedN: 0,
      selfieEnabled: true,
      pmProxyDays: 7,
    };
    expect(parseFieldSettingsCommand(settings).pmProxyDays).toBe(7);
    expect(() =>
      parseFieldSettingsCommand({ ...settings, selfieEnabled: 'yes' }),
    ).toThrow(InvalidReportInput);
    expect(() =>
      parseFieldSettingsCommand({ ...settings, pmProxyDays: 0 }),
    ).toThrow(InvalidReportInput);
  });
  it('a selfie upload carries only its key', () => {
    expect(parseSelfieUploadCommand({ clientMutationId: id })).toEqual({
      clientMutationId: id,
    });
    expect(() =>
      parseSelfieUploadCommand({ clientMutationId: id, personId: id }),
    ).toThrow(InvalidReportInput);
  });
});
