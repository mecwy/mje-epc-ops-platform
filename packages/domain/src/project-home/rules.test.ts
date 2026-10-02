import { describe, expect, it } from 'vitest';
import { completion, forecastCompletion, statusAge } from './rules.js';

describe('project home derived values', () => {
  it('distinguishes unset work, unknown values and a declared zero', () => {
    expect(completion(null, '10', '0')).toEqual({ state: 'UNCONFIGURED' });
    expect(completion(undefined, '10', '0')).toEqual({ state: 'NOT_FROZEN' });
    expect(completion('module', '10', 'unknown')).toEqual({
      state: 'NOT_COMPUTABLE',
    });
    expect(completion('module', '0', '0')).toEqual({
      state: 'NOT_COMPUTABLE',
    });
    expect(completion('module', '10', '0')).toEqual({
      state: 'COMPUTABLE',
      percent: '0.0',
      aboveDesign: false,
    });
    expect(completion('module', '10', '12')).toEqual({
      state: 'COMPUTABLE',
      percent: '120.0',
      aboveDesign: true,
    });
  });

  it('uses site business-date age with the seven-day boundary', () => {
    expect(statusAge('2030-01-08', '2030-01-01')).toEqual({
      stale: false,
      staleDays: 7,
      undeclared: false,
    });
    expect(statusAge('2030-01-09', '2030-01-01')).toEqual({
      stale: true,
      staleDays: 8,
      undeclared: false,
    });
    expect(statusAge('2030-01-09', null)).toEqual({
      stale: false,
      staleDays: null,
      undeclared: true,
    });
  });

  it('restarts the forecast sample after primary item or unit changes', () => {
    expect(
      forecastCompletion({
        today: '2030-01-10',
        primaryWorkItemKey: 'module',
        unit: 'piece',
        designQty: '10',
        cumulative: '4',
        observations: [
          {
            businessDate: '2030-01-04',
            primaryWorkItemKey: 'module',
            unit: 'piece',
            qty: '8',
          },
          {
            businessDate: '2030-01-07',
            primaryWorkItemKey: 'module',
            unit: 'meter',
            qty: '100',
          },
          {
            businessDate: '2030-01-08',
            primaryWorkItemKey: 'module',
            unit: 'piece',
            qty: '1',
          },
          {
            businessDate: '2030-01-09',
            primaryWorkItemKey: 'module',
            unit: 'piece',
            qty: '2',
          },
        ],
      }),
    ).toEqual({
      state: 'ESTIMATE',
      expectedDate: '2030-01-14',
      sampleDays: 2,
    });
  });

  it('does not forecast a completed or wholly unknown work item', () => {
    const shared = {
      today: '2030-01-10',
      primaryWorkItemKey: 'module',
      unit: 'piece',
      designQty: '10',
      observations: [
        {
          businessDate: '2030-01-09',
          primaryWorkItemKey: 'module',
          unit: 'piece',
          qty: 'unknown',
        },
      ],
    };
    expect(forecastCompletion({ ...shared, cumulative: '10' })).toEqual({
      state: 'AT_DESIGN',
    });
    expect(forecastCompletion({ ...shared, cumulative: '4' })).toEqual({
      state: 'NOT_COMPUTABLE',
    });
  });

  it('ignores submitted observations outside the seven business-date window', () => {
    expect(
      forecastCompletion({
        today: '2030-01-10',
        primaryWorkItemKey: 'module',
        unit: 'piece',
        designQty: '20',
        cumulative: '4',
        observations: [
          {
            businessDate: '2030-01-01',
            primaryWorkItemKey: 'module',
            unit: 'piece',
            qty: '100',
          },
          {
            businessDate: '2030-01-09',
            primaryWorkItemKey: 'module',
            unit: 'piece',
            qty: '2',
          },
          {
            businessDate: '2030-01-10',
            primaryWorkItemKey: 'module',
            unit: 'piece',
            qty: '2',
          },
        ],
      }),
    ).toEqual({ state: 'ESTIMATE', expectedDate: '2030-01-18', sampleDays: 2 });
  });
});
