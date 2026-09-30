import { describe, expect, it } from 'vitest';
import {
  parseChallengeConfirmCommand,
  parseForemanReportCommand,
  type FieldMeDto,
  type ForemanReportDto,
} from '@mje/contracts';
import {
  changedOnServer,
  checkDraft,
  crewDecision,
  draftFrom,
  qtyKind,
  reportDays,
} from './foreman-report.js';

const dto = (rows: ForemanReportDto['rows'] = [], n = 0): ForemanReportDto => ({
  crewId: '11111111-1111-4111-8111-111111111111',
  crewName: 'TEST crew',
  businessDate: '2026-10-02',
  n,
  rows,
  note: '',
  occurredAt: null,
  receivedAt: null,
  items: [
    { key: 'support', label: 'itSupport', unit: 'set' },
    { key: 'modules', label: 'itModules', unit: 'pcs' },
    { key: 'cable', label: 'itDcCable', unit: 'm' },
  ],
});

describe('foreman quantity report', () => {
  it('keeps blank, 0, unknown, n/a and numbers apart', () => {
    expect(qtyKind('')).toBe('blank');
    expect(qtyKind('  ')).toBe('blank');
    expect(qtyKind('0')).toBe('zero');
    expect(qtyKind('0.000')).toBe('zero');
    expect(qtyKind('unknown')).toBe('unknown');
    expect(qtyKind('na')).toBe('na');
    expect(qtyKind('12.5')).toBe('number');
    expect(qtyKind('1,5')).toBe('number');
    // Decimal(20,6): 14 integer digits and 6 decimals at most; nothing is corrected.
    expect(qtyKind('99999999999999.999999')).toBe('number');
    for (const bad of [
      '1e3',
      '-1',
      '123456789012345',
      '1.1234567',
      'abc',
      'NaN',
    ])
      expect(qtyKind(bad), bad).toBe('invalid');
  });
  it('starts from every active item, blank unless the latest revision has it', () => {
    const d = draftFrom(
      dto([
        { itemKey: 'support', qty: '0' },
        { itemKey: 'modules', qty: 'unknown' },
        { itemKey: 'retired', qty: '5' },
      ]),
    );
    expect(d).toEqual({ support: '0', modules: 'unknown', cable: '' });
  });
  it('sends every item in order with blanks kept, and names invalid entries instead of fixing them', () => {
    const r = dto();
    const ok = checkDraft(r, { support: ' 12 ', modules: '', cable: 'na' });
    expect(ok).toEqual({
      ok: true,
      rows: [
        { itemKey: 'support', qty: '12' },
        { itemKey: 'modules', qty: '' },
        { itemKey: 'cable', qty: 'na' },
      ],
    });
    if (ok.ok)
      expect(
        parseForemanReportCommand({
          clientMutationId: '22222222-2222-4222-8222-222222222222',
          businessDate: '2026-10-02',
          crewId: r.crewId,
          expectedRevision: 0,
          rows: ok.rows,
          note: '',
          occurredAt: '2026-10-02T08:00:00.000Z',
        }).rows,
      ).toEqual(ok.rows);
    expect(checkDraft(r, { support: '1e3', modules: '-2', cable: '' })).toEqual(
      {
        ok: false,
        invalid: ['support', 'modules'],
      },
    );
  });
  it('after a conflict names exactly the items the newer revision changed', () => {
    const base = { support: '10', modules: '', cable: 'unknown' };
    const latest = { support: '12', modules: '', cable: 'unknown', extra: '1' };
    expect(changedOnServer(base, latest).sort()).toEqual(['extra', 'support']);
    expect(changedOnServer(base, { ...base })).toEqual([]);
    // blank vs 0 is a change
    expect(changedOnServer({ a: '' }, { a: '0' })).toEqual(['a']);
  });
  it("offers the site's today and yesterday only", () => {
    // 00:30 in Belgrade on 3 October is 22:30 UTC on 2 October.
    expect(
      reportDays('Europe/Belgrade', new Date('2026-10-02T22:30:00.000Z')),
    ).toEqual(['2026-10-03', '2026-10-02']);
  });
});

const meWith = (current: string | null): FieldMeDto => ({
  device: {
    deviceId: 'd',
    state: 'CONFIRMED',
    generation: 0,
    pendingUntil: null,
    expiresAt: '2027-01-01T00:00:00.000Z',
    memberUntil: null,
    tokenIssuedAt: '2026-10-01T00:00:00.000Z',
  },
  person: {
    id: '33333333-3333-4333-8333-333333333333',
    displayName: 'TEST foreman',
  },
  project: { id: 'p', name: 'TEST', timezone: 'Europe/Belgrade' },
  settings: { selfieEnabled: false },
  crew: null,
  foreman: {
    crewId: 'c',
    crewName: 'TEST crew',
    members: [
      {
        personId: '44444444-4444-4444-8444-444444444444',
        displayName: 'TEST worker',
        currentDeviceId: current,
        pendingDevices: 1,
      },
    ],
  },
});
describe('foreman confirm / reject by code', () => {
  const W = '44444444-4444-4444-8444-444444444444';
  const K = '55555555-5555-4555-8555-555555555555';
  it('sends the member’s current phone as the newest reading shows it', () => {
    const d = crewDecision(meWith(null), W, '123456', K, 'confirm');
    expect(d).toEqual({
      kind: 'confirm',
      command: {
        clientMutationId: K,
        personId: W,
        code: '123456',
        expectedCurrentDeviceId: null,
      },
    });
    const newer = crewDecision(
      meWith('66666666-6666-4666-8666-666666666666'),
      W,
      '123456',
      K,
      'confirm',
    );
    expect(
      newer?.kind === 'confirm' && newer.command.expectedCurrentDeviceId,
    ).toBe('66666666-6666-4666-8666-666666666666');
    if (newer?.kind === 'confirm')
      expect(parseChallengeConfirmCommand(newer.command)).toEqual(
        newer.command,
      );
  });
  it('rejects by code without a device id, and sends nothing for someone no longer in the crew', () => {
    expect(crewDecision(meWith(null), W, '123456', K, 'reject')).toEqual({
      kind: 'reject',
      command: { clientMutationId: K, personId: W, code: '123456' },
    });
    expect(crewDecision(meWith(null), 'x', '123456', K, 'confirm')).toBeNull();
    expect(crewDecision(null, W, '123456', K, 'confirm')).toBeNull();
  });
});
