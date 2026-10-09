import { expect, it } from 'vitest';
import { projectMaterialQuantities as project } from './material-continuity-rules.js';
import type { ReportActivity } from '@mje/contracts';
import {
  materialUseDifference,
  missingMaterialDays,
  isMaterialOpeningDayStart,
} from './material-continuity-rules.js';

it('requires the start of the site day because this slice cannot split daily consumption around a midday count', () => {
  expect(
    isMaterialOpeningDayStart(
      '2031-01-01T00:00:00+01:00',
      '2031-01-01',
      'Europe/Belgrade',
    ),
  ).toBe(true);
  expect(
    isMaterialOpeningDayStart(
      '2031-01-01T00:00:00Z',
      '2031-01-01',
      'Europe/Belgrade',
    ),
  ).toBe(false);
  expect(
    isMaterialOpeningDayStart(
      '2031-01-01T12:00:00+01:00',
      '2031-01-01',
      'Europe/Belgrade',
    ),
  ).toBe(false);
  expect(
    isMaterialOpeningDayStart(
      '2031-01-01T00:00:00.001+01:00',
      '2031-01-01',
      'Europe/Belgrade',
    ),
  ).toBe(false);
  expect(
    isMaterialOpeningDayStart(
      '2031-07-01T00:00:00+02:00',
      '2031-07-01',
      'Europe/Belgrade',
    ),
  ).toBe(true);
});

it('500 less admitted368 carries132; reversal/replacement reprojects140/40 without altering frozen values', () => {
  const rows = [
    { businessDate: '2031-01-01', kind: 'opening' as const, quantity: '500' },
    { businessDate: '2031-01-01', kind: 'use' as const, quantity: '-368' },
    { businessDate: '2031-01-02', kind: 'use' as const, quantity: '-100' },
  ];
  const frozen1 = project('scope', '2031-01-01', true, rows, 0);
  const frozen2 = project('scope', '2031-01-02', true, rows, 0);
  expect(frozen1.balance).toBe('132');
  expect(frozen2.opening).toBe('132');
  expect(frozen2.balance).toBe('32');
  const corrected = [
    ...rows,
    { businessDate: '2031-01-01', kind: 'reversal' as const, quantity: '368' },
    { businessDate: '2031-01-01', kind: 'use' as const, quantity: '-360' },
  ];
  expect(project('scope', '2031-01-01', true, corrected, 0).balance).toBe(
    '140',
  );
  expect(project('scope', '2031-01-02', true, corrected, 0).balance).toBe('40');
  expect(frozen1.balance).toBe('132');
  expect(frozen2.balance).toBe('32');
});
it('unknown opening stays unknown, and pending use warns without adopting an estimate or zero', () => {
  const q = project('s', '2031-01-01', false, [], 1);
  expect(q.balance).toBeNull();
  expect(q.complete).toBe(false);
  expect(q.independentVerification).toBe(false);
  expect(
    project(
      's',
      '2031-01-01',
      true,
      [{ businessDate: '2031-01-01', kind: 'opening', quantity: '500' }],
      1,
    ).balance,
  ).toBe('500');
});
it('1200 includes today360: independently admitted840+360 against opening10000 leaves8800', () => {
  const r = project(
    's',
    '2031-02-02',
    true,
    [
      { businessDate: '2031-02-01', kind: 'opening', quantity: '10000' },
      { businessDate: '2031-02-01', kind: 'use', quantity: '-840' },
      { businessDate: '2031-02-02', kind: 'use', quantity: '-360' },
    ],
    0,
  );
  expect(r.admittedUseCumulative).toBe('1200');
  expect(r.admittedUseToday).toBe('360');
  expect(r.balance).toBe('8800');
});

it('missing submitted days inside the window are unknown, while explicit submitted dates close the gap', () => {
  expect(
    missingMaterialDays('2031-01-01', '2031-01-03', [
      '2031-01-01',
      '2031-01-03',
    ]),
  ).toBe(1);
  expect(
    missingMaterialDays('2031-01-01', '2031-01-03', [
      '2031-01-01',
      '2031-01-02',
      '2031-01-03',
    ]),
  ).toBe(0);
  expect(missingMaterialDays('2031-01-01', '2031-01-03', [])).toBe(3);
});
it('one difference rule uses documented installation mapping, current output and explicit reason; never unrelated numbers', () => {
  const a = {
    outputKind: 'installation',
    quantity: '360',
    outputUnit: 'set',
    use: {
      state: 'declared',
      actualQuantity: '368',
      unit: 'set',
      differenceNote: '',
      estimate: { ratio: '1', outputUnit: 'set', materialUnit: 'set' },
    },
  } as ReportActivity;
  expect(materialUseDifference(a)).toEqual({
    expectedConsumption: '360',
    difference: '8',
    followupRequired: true,
  });
  expect(materialUseDifference({ ...a, quantity: '376' }).difference).toBe(
    '-8',
  );
  expect(
    materialUseDifference({ ...a, quantity: '368' }).followupRequired,
  ).toBe(false);
  expect(materialUseDifference({ ...a, quantity: '' })).toEqual({
    expectedConsumption: null,
    difference: null,
    followupRequired: true,
  });
  expect(
    materialUseDifference({
      ...a,
      use: { ...a.use!, differenceNote: 'TEST manual explanation' },
    }).followupRequired,
  ).toBe(false);
  expect(
    materialUseDifference({ ...a, use: { ...a.use!, estimate: null } }),
  ).toEqual({
    expectedConsumption: null,
    difference: null,
    followupRequired: false,
  });
  expect(
    materialUseDifference({
      ...a,
      outputKind: 'process',
      quantity: '10',
      outputUnit: 'm2',
      use: { ...a.use!, actualQuantity: '3' },
    }),
  ).toEqual({
    expectedConsumption: null,
    difference: null,
    followupRequired: false,
  });
});
