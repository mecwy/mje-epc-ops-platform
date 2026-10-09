import { describe, expect, it } from 'vitest';
import {
  newActivity,
  editActivity,
  pendingActivityUse,
  withActivities,
} from './activity-model.js';
import type { ActivityMaterialMapping, ReportItemDto } from '@mje/contracts';

const work: ReportItemDto = {
  kind: 'work',
  key: 'testInstall',
  label: 'TEST install',
  unit: 'set',
  designQty: '',
  openingCumulative: '',
  sortOrder: 1,
  active: true,
};
const rule: ActivityMaterialMapping = {
  orgId: '10000000-0000-4000-8000-000000000001',
  projectId: '10000000-0000-4000-8000-000000000002',
  workItemId: '10000000-0000-4000-8000-000000000003',
  materialItemId: '10000000-0000-4000-8000-000000000004',
  validFrom: '2030-01-01',
  basisRef: 'TEST basis',
  workPackageId: 'TEST package',
  scopeVersion: '1',
  area: 'TEST area',
  workItemKey: 'testInstall',
  materialKey: 'testMounts',
  specification: 'TEST spec',
  outputUnit: 'set',
  materialUnit: 'set',
  ruleId: 'TEST explicit1to1',
  ruleVersion: '1',
  mappingVersion: '1',
  ratio: '1',
};
describe('activity card editing', () => {
  it('recalculates only untouched estimate; typing the same368 is still manual', () => {
    const a = newActivity(work, rule, '368');
    expect(editActivity(a, 'quantity', '360').use!.estimate!.quantity).toBe(
      '360',
    );
    const manual = editActivity(a, 'consumption', '368');
    const changed = editActivity(manual, 'quantity', '360');
    expect(changed.use!.state).toBe('edited');
    expect(changed.use!.actualQuantity).toBe('368');
    expect(changed.use!.reviewRequired).toBe(true);
  });
  it('keeps adjusted370 and explanation after output change and pending round-trip', () => {
    let a = editActivity(newActivity(work, rule, '368'), 'consumption', '370');
    a = editActivity(a, 'explanation', 'TEST explanation');
    a = pendingActivityUse(a, true);
    a = editActivity(a, 'quantity', '360');
    a = pendingActivityUse(a, false);
    expect(a.use!.actualQuantity).toBe('370');
    expect(a.use!.differenceNote).toBe('TEST explanation');
    expect(a.use!.state).toBe('edited');
  });
  it('does not supply a universal1to1 rule for an unconfigured material', () => {
    const a = newActivity(work, undefined, '368');
    expect(a.use!.state).toBe('pending');
    expect(a.use!.estimate).toBeNull();
    expect(a.use!.materialKey).toBeNull();
  });
  it('updates only linked installation output without touching arrivals or end-of-day cumulative8773', () => {
    const a = newActivity(work, rule, '368');
    const predecessor = newActivity(work, undefined, '368');
    predecessor.outputKind = 'process';
    const f = {
      weather: '',
      temperature: '',
      qty: {},
      cumulative: { testInstall: '8773' },
      narrative: { construction: '', quality: '', safety: '' },
      people: {},
      presence: {},
      machinery: {},
      materials: { testMounts: '0' },
      milestones: {},
      noWork: null,
      updated: {},
    };
    const changed = withActivities(f, [a, predecessor]);
    expect(changed.qty.testInstall).toBe('368');
    expect(changed.cumulative.testInstall).toBe('8773');
    expect(changed.materials.testMounts).toBe('0');
    expect(a.operationId).not.toBe(predecessor.operationId);
  });
});
