import { describe, expect, it } from 'vitest';
import { allowsHeader, type ContractGrant } from './rules.js';
import { decide } from '../authz/interpret.js';
import { SURFACE } from '../authz/surface.js';
describe('contract header scope', () => {
  it('does not infer capabilities or whole-contract access from project or other direction', () => {
    const g: ContractGrant[] = [
      {
        capability: 'contract.maintain',
        scope: 'ORG',
        direction: 'ALL',
        projectId: null,
      },
      {
        capability: 'contract.view',
        scope: 'PROJECT',
        direction: 'ALL',
        projectId: 'TEST-project',
      },
      {
        capability: 'contract.amount',
        scope: 'ORG',
        direction: 'EXPENDITURE',
        projectId: null,
      },
    ];
    expect(allowsHeader(g, 'contract.view', 'INCOME')).toBe(false);
    expect(allowsHeader(g, 'contract.amount', 'INCOME')).toBe(false);
    expect(allowsHeader(g, 'contract.amount', 'EXPENDITURE')).toBe(true);
  });
  it('does not let the legacy test interpreter pretend to evaluate explicit direction grants', () => {
    expect(() =>
      decide(
        SURFACE.find((e) => e.entry === 'GET /api/contracts')!,
        {
          principal: 'account',
          capabilities: ['contract.view'],
          scope: 'granted',
        },
      ),
    ).toThrow('EXPLICIT_GRANT_CONTEXT_REQUIRED');
  });
});
