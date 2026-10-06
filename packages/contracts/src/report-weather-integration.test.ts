import { describe, expect, it } from 'vitest';
import { parseFacts, parseSaveFactsCommand } from './report.js';
const projectId = '10000000-0000-4000-8000-000000000001';
const snapshotId = '20000000-0000-4000-8000-000000000001';
const locationVersionId = '30000000-0000-4000-8000-000000000001';
const at = '2026-10-06T12:00:00.000Z';
const safeLocation = {
  recordId: snapshotId,
  accuracyM: '10.00',
  deviceFixAt: null,
  acquiredAt: at,
  clientConfirmedAt: at,
  serverReceivedAt: at,
};
const base = {
  projectId,
  businessDate: '2026-10-06',
  expectedVersion: 0,
  clientMutationId: snapshotId,
  facts: {},
};
describe('weather joins the existing report command boundary', () => {
  it('keeps omission distinct from explicitly empty/clear draft references', () => {
    expect(parseFacts({})).not.toHaveProperty('weatherReferences');
    expect(parseFacts({})).not.toHaveProperty('reportLocationRef');
    expect(
      parseFacts({ weatherReferences: [], reportLocationRef: null }),
    ).toMatchObject({ weatherReferences: [], reportLocationRef: null });
    expect(parseSaveFactsCommand(base)).not.toHaveProperty(
      'reportLocationOperation',
    );
    expect(
      parseSaveFactsCommand({
        ...base,
        reportLocationOperation: { kind: 'clear' },
      }).reportLocationOperation,
    ).toEqual({ kind: 'clear' });
  });
  it('round-trips only safe reference IDs and metadata alongside manual declarations', () => {
    expect(
      parseFacts({
        people: { installer: '0' },
        weatherReferences: [{ snapshotId, locationVersionId }],
        reportLocationRef: safeLocation,
      }),
    ).toMatchObject({
      people: { installer: '0' },
      weatherReferences: [{ snapshotId, locationVersionId }],
      reportLocationRef: safeLocation,
    });
  });
  it('keeps capture coordinates only in the command operation, retaining raw precision', () => {
    const result = parseSaveFactsCommand({
      ...base,
      reportLocationOperation: {
        kind: 'capture',
        candidate: {
          lat: '44.123456789012',
          lon: '19.123456789012',
          accuracyM: '10.00',
          deviceFixAt: null,
          acquiredAt: at,
        },
        clientConfirmedAt: at,
      },
    });
    expect(result.reportLocationOperation).toMatchObject({
      kind: 'capture',
      candidate: { lat: '44.123456789012', lon: '19.123456789012' },
    });
    expect(JSON.stringify(result.facts)).not.toContain('44.123456789012');
  });
  it.each([
    { lat: '44.123456789012' },
    { reportLocationRef: { ...safeLocation, lat: '44.123456789012' } },
    {
      weatherReferences: [
        { snapshotId, locationVersionId, adoptedByPersonId: projectId },
      ],
    },
  ])(
    'refuses raw coordinates or client adoption metadata in generic facts',
    (input) => {
      expect(() => parseFacts(input)).toThrow();
    },
  );
  it('refuses unknown operation fields and client-supplied authorization context', () => {
    expect(() =>
      parseSaveFactsCommand({ ...base, orgId: projectId }),
    ).toThrow();
    expect(() =>
      parseSaveFactsCommand({
        ...base,
        reportLocationOperation: { kind: 'clear', lat: '44' },
      }),
    ).toThrow();
  });
});
