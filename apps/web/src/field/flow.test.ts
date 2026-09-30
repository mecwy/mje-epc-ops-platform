import { describe, expect, it } from 'vitest';
import type { EntryDto, FieldMeDto } from '@mje/contracts';
import {
  DeviceStore,
  endedReason,
  newToken,
  type DeviceRecord,
} from './device-store.js';
import { canRelease, codeFromHash, deviceView, startScreen } from './flow.js';

const P = '11111111-1111-4111-8111-111111111111';
const Q = '22222222-2222-4222-8222-222222222222';
const token = (n: number) => newToken((a) => a.fill(n));
const record = (
  projectId: string,
  over: Partial<DeviceRecord> = {},
): DeviceRecord => ({
  projectId,
  projectName: 'TEST project',
  personId: '33333333-3333-4333-8333-333333333333',
  displayName: 'TEST worker',
  token: token(1),
  deviceId: '44444444-4444-4444-8444-444444444444',
  last: null,
  ...over,
});
const entry = (projectId: string): EntryDto => ({
  project: { id: projectId, name: 'TEST project' },
  roster: [],
});
const me = (state: FieldMeDto['device']['state']): FieldMeDto => ({
  device: {
    deviceId: 'd',
    state,
    generation: 0,
    pendingUntil: null,
    expiresAt: '2027-01-01T00:00:00.000Z',
    memberUntil: null,
    tokenIssuedAt: '2026-10-01T00:00:00.000Z',
  },
  person: { id: 'p', displayName: 'TEST worker' },
  project: { id: P, name: 'TEST project', timezone: 'Europe/Belgrade' },
  settings: { selfieEnabled: false },
  crew: null,
  foreman: null,
});
const now = new Date('2026-10-02T08:00:00.000Z');

describe('device page state machine', () => {
  it('a scanned code opens the roster unless this browser already holds a device there', () => {
    expect(startScreen('c', { ok: entry(P) }, [])).toMatchObject({
      kind: 'roster',
    });
    expect(
      startScreen('c', { ok: entry(P) }, [record(Q), record(P)]),
    ).toMatchObject({
      kind: 'device',
      record: { projectId: P },
    });
    // No code: the most recent device, else ask to scan.
    expect(startScreen(null, null, [record(Q)])).toMatchObject({
      kind: 'device',
    });
    expect(startScreen(null, null, [])).toEqual({ kind: 'scan' });
  });
  it('a failed entry code shows its error and still offers a device held here', () => {
    expect(
      startScreen('c', { error: 'ENTRY_CODE_INVALID' }, [record(Q)]),
    ).toMatchObject({
      kind: 'entryFailed',
      code: 'ENTRY_CODE_INVALID',
      device: { projectId: Q },
    });
    expect(startScreen('c', { error: 'NETWORK' }, [])).toMatchObject({
      kind: 'entryFailed',
      device: null,
    });
  });
  it('maps me and read errors to pending, home, ended or unreachable', () => {
    const r = record(P);
    expect(deviceView(null, null, r, now)).toEqual({ kind: 'loading' });
    expect(deviceView(me('PENDING'), null, r, now).kind).toBe('pending');
    expect(deviceView(me('CONFIRMED'), null, r, now).kind).toBe('home');
    expect(deviceView(null, 'DEVICE_ENDED', r, now).kind).toBe('ended');
    expect(deviceView(null, 'FIELD_AUTH_REQUIRED', r, now).kind).toBe('ended');
    // An ended answer wins over an older good reading (revoked while the page was open).
    expect(deviceView(me('CONFIRMED'), 'DEVICE_ENDED', r, now).kind).toBe(
      'ended',
    );
    // A transient failure keeps the last reading; without one it is unreachable, never ended.
    expect(deviceView(me('CONFIRMED'), 'NETWORK', r, now).kind).toBe('home');
    expect(deviceView(null, 'NETWORK', r, now)).toEqual({
      kind: 'unreachable',
      code: 'NETWORK',
    });
    expect(deviceView(null, 'RATE_LIMITED', r, now).kind).toBe('unreachable');
  });
  it('explains an end from the last deadlines seen, else as revoked', () => {
    const last = (o: Partial<NonNullable<DeviceRecord['last']>>) => ({
      state: 'CONFIRMED' as const,
      pendingUntil: null,
      expiresAt: '2027-01-01T00:00:00.000Z',
      memberUntil: null,
      okAt: '2026-10-01T00:00:00.000Z',
      ...o,
    });
    expect(endedReason(null, now)).toBe('revoked');
    expect(endedReason(last({}), now)).toBe('revoked');
    expect(
      endedReason(
        last({ state: 'PENDING', pendingUntil: '2026-10-02T07:59:59.000Z' }),
        now,
      ),
    ).toBe('pendingExpired');
    expect(
      endedReason(last({ memberUntil: '2026-10-02T07:00:00.000Z' }), now),
    ).toBe('unassigned');
    expect(
      endedReason(last({ expiresAt: '2026-10-02T08:00:00.000Z' }), now),
    ).toBe('expired');
    expect(endedReason(last({ okAt: '2026-09-02T08:00:00.000Z' }), now)).toBe(
      'idle',
    );
    expect(endedReason(last({ okAt: '2026-09-02T08:00:01.000Z' }), now)).toBe(
      'revoked',
    );
  });
  it('reads the entry code only from a well-formed fragment', () => {
    expect(codeFromHash('#e=AbCdEfGhIjKlMnOpQrStU_')).toBe(
      'AbCdEfGhIjKlMnOpQrStU_',
    );
    expect(codeFromHash('#e=short')).toBeNull();
    expect(codeFromHash('#e=AbCdEfGhIjKlMnOpQrStU_&x=1')).toBeNull();
    expect(codeFromHash('')).toBeNull();
  });
});

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}
describe('device store', () => {
  it('makes contract-shaped tokens from 32 random bytes', () => {
    expect(token(0)).toMatch(/^fd1\.[A-Za-z0-9_-]{43}$/);
    expect(token(255)).toBe(`fd1.${'_'.repeat(42)}8`);
    expect(newToken()).not.toBe(newToken());
  });
  it('keeps one device per project, newest first, and ignores malformed storage', () => {
    const s = memoryStorage();
    const store = new DeviceStore(s);
    store.put(record(P));
    store.put(record(Q));
    store.put(record(P, { displayName: 'TEST again' }));
    expect(store.all().map((r) => r.projectId)).toEqual([P, Q]);
    expect(store.get(P)?.displayName).toBe('TEST again');
    s.setItem(
      'mje-field-devices',
      JSON.stringify([{ projectId: P, token: 'not-a-token' }, record(Q)]),
    );
    expect(store.all().map((r) => r.projectId)).toEqual([Q]);
    s.setItem('mje-field-devices', '{broken');
    expect(new DeviceStore(s).all()).toEqual([]);
  });
  it('removes only the record holding that token (an old tab never drops a newer registration)', () => {
    const store = new DeviceStore(memoryStorage());
    store.put(record(P, { token: token(2) }));
    store.remove(P, token(1));
    expect(store.get(P)?.token).toBe(token(2));
    store.remove(P, token(2));
    expect(store.get(P)).toBeNull();
  });
  it('records a reading only for the current token, and works without storage', () => {
    const store = new DeviceStore(null);
    store.put(record(P));
    const last = store.seen(P, token(9), me('CONFIRMED'), now);
    expect(last?.okAt).toBe(now.toISOString());
    expect(store.get(P)?.last).toBeNull();
    store.seen(P, token(1), me('CONFIRMED'), now);
    expect(store.get(P)?.last?.state).toBe('CONFIRMED');
    const throwing = {
      ...memoryStorage(),
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    } as Storage;
    const blocked = new DeviceStore(throwing);
    blocked.put(record(P));
    expect(blocked.get(P)?.projectId).toBe(P);
  });
  it('#8 keeps a record for the visit when storage can be read but not written (quota)', () => {
    const backing = memoryStorage();
    backing.setItem('mje-field-devices', JSON.stringify([record(Q)]));
    const quota = {
      ...backing,
      getItem: (k: string) => backing.getItem(k),
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    } as Storage;
    const store = new DeviceStore(quota);
    const fresh = record(P, { token: token(7), deviceId: null });
    store.put(fresh);
    // A lost bind answer is retried with the same token, never a new one.
    expect(store.get(P)?.token).toBe(token(7));
    expect(store.all().map((r) => r.projectId)).toEqual([P, Q]);
    store.remove(P, token(7));
    expect(store.get(P)).toBeNull();
  });
});

describe('unregister is offered for every live device (#5)', () => {
  it('pending and confirmed, not ended or unreachable', () => {
    const r = record(P);
    expect(canRelease(deviceView(me('PENDING'), null, r, now))).toBe(true);
    expect(canRelease(deviceView(me('CONFIRMED'), null, r, now))).toBe(true);
    expect(canRelease(deviceView(null, 'DEVICE_ENDED', r, now))).toBe(false);
    expect(canRelease(deviceView(null, 'NETWORK', r, now))).toBe(false);
  });
});
