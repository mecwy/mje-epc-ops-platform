import { describe, expect, it } from 'vitest';
import { parseManagerReviewScope } from './manager-review-service.js';
const scope = {
  projectId: '00000000-0000-4000-8000-000000000001',
  businessDate: '2026-10-06',
  crewId: '00000000-0000-4000-8000-000000000002',
  itemKey: 'TEST_work',
};
describe('TEST manager review scope transport', () => {
  it('copies only exact scope identifiers', () => {
    const parsed = parseManagerReviewScope(scope);
    expect(parsed).toEqual(scope);
    expect(parsed).not.toBe(scope);
  });
  it.each(['orgId', 'actorId', 'role', 'canWrite', 'foremanRevisionId'])(
    'rejects forged/extraneous %s before a service transaction',
    (key) => {
      expect(() =>
        parseManagerReviewScope({ ...scope, [key]: 'TEST_forged' }),
      ).toThrow();
    },
  );
  it.each(['2026-02-30', '', 'TEST_date'])(
    'rejects invalid day %s',
    (businessDate) => {
      expect(() =>
        parseManagerReviewScope({ ...scope, businessDate }),
      ).toThrow();
    },
  );
});
