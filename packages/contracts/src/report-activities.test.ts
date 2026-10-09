import { describe, expect, it } from 'vitest';
import {
  parseActivityUseConfirmation,
  parseReportActivities,
} from './report-activities.js';
describe('activity command admission', () => {
  it('rejects duplicate or malformed confirmation identities and invalid version', () => {
    const id = '10000000-0000-4000-8000-000000000001';
    for (const value of [
      { draftVersion: 1, includedUseFactIds: [id, id] },
      { draftVersion: -1, includedUseFactIds: [] },
      { draftVersion: 1, includedUseFactIds: ['bad'] },
      { draftVersion: 1, includedUseFactIds: [], verified: true },
    ])
      expect(() => parseActivityUseConfirmation(value)).toThrow();
  });
  it('bounds activity count and refuses untyped facts', () => {
    expect(parseReportActivities([])).toEqual([]);
    expect(() => parseReportActivities(Array(101).fill({}))).toThrow();
    expect(() => parseReportActivities([{ verified: true }])).toThrow();
  });
});
