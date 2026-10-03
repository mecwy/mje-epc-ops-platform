import { describe, expect, it } from 'vitest';
import { ROLE_KEYS } from '@mje/domain/rules';
import { workforceSummary } from './overview-workforce.js';
const roles = (value: string) =>
  Object.fromEntries(ROLE_KEYS.map((k) => [k, value]));
describe('overview declared workforce', () => {
  it('keeps blank, unknown, N/A and explicit zero distinct', () => {
    expect(workforceSummary({})).toEqual({ state: 'blank', value: null });
    expect(workforceSummary(roles('unknown'))).toEqual({
      state: 'unknown',
      value: null,
    });
    expect(workforceSummary(roles('na'))).toEqual({ state: 'na', value: null });
    expect(workforceSummary(roles('0'))).toEqual({
      state: 'complete',
      value: '0',
    });
  });
  it('labels numeric subtotals incomplete when any category is unknown or blank', () => {
    expect(workforceSummary({ installer: '12' })).toEqual({
      state: 'partial',
      value: '12',
    });
    expect(
      workforceSummary({ ...roles('na'), installer: '12', manager: 'unknown' }),
    ).toEqual({ state: 'partial', value: '12' });
    expect(workforceSummary({ ...roles('na'), installer: '12' })).toEqual({
      state: 'complete',
      value: '12',
    });
  });
  it('uses exact decimal sums and produces no hours or productivity estimates', () => {
    expect(
      workforceSummary({ ...roles('0'), installer: '0.1', manager: '0.2' }),
    ).toEqual({ state: 'complete', value: '0.3' });
  });
});
