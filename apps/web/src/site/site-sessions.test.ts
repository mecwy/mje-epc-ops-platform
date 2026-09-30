import { describe, expect, it } from 'vitest';
import type {
  EntryCodeDto,
  FieldDeviceDto,
  FieldSettingsDto,
  SiteReferenceCommand,
} from '@mje/contracts';
import { ApiError } from '../api.js';
import { OwnedCommands } from '../field/owned-commands.js';
import { FieldSession } from '../field/session.js';
import {
  DeviceCommands,
  SiteSessions,
  qrState,
  saveSettings,
  saveSiteReference,
  settingsCommand,
} from './site-sessions.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const P = '11111111-1111-4111-8111-111111111111';
const settingsAt = (n: number, radiusM = 500): FieldSettingsDto => ({
  projectId: P,
  // TEST coordinates only.
  siteReference: { n, lat: '1.000000', lon: '1.000000', radiusM },
  settings: { n, selfieEnabled: false, pmProxyDays: 7 },
});

describe('#1 settings save against the version the form was edited from', () => {
  it('a stale form is refused after a failed conflict reread, never overwrites the newer reference', async () => {
    // A fake server: reference n=1, another PM then saves n=2 (radius 900).
    let server = settingsAt(1);
    let readsFail = false;
    const writes: SiteReferenceCommand[] = [];
    const session = new FieldSession<FieldSettingsDto>(
      async () => {
        if (readsFail) throw new ApiError('NETWORK', 0);
        return server;
      },
      () => {},
    );
    await session.load();
    const editedFrom = session.data!;
    server = settingsAt(2, 900);
    const api = {
      setSiteReference: async (c: SiteReferenceCommand) => {
        writes.push(c);
        if (c.expectedN !== server.siteReference!.n)
          throw new ApiError('VERSION_CONFLICT', 409);
        server = settingsAt(c.expectedN + 1, c.radiusM);
        return { n: c.expectedN + 1 };
      },
    };
    // The form was edited on n=1 (radius 300).
    const save = () =>
      saveSiteReference(new OwnedCommands(session), api, P, editedFrom, {
        lat: '1.000000',
        lon: '1.000000',
        radiusM: 300,
      });
    readsFail = true;
    expect((await save()).kind).toBe('rejected');
    expect(session.error).toBe('VERSION_CONFLICT');
    // Connectivity back; the PM presses Save again on the old form.
    readsFail = false;
    const again = await save();
    expect(again).toMatchObject({ kind: 'rejected', code: 'VERSION_CONFLICT' });
    expect(writes.map((w) => w.expectedN)).toEqual([1, 1]);
    expect(server.siteReference!.radiusM).toBe(900);
    // The newer reference is what the card now shows.
    expect(session.data!.siteReference!.n).toBe(2);
  });
  it('field settings use the edited-from number too', async () => {
    let server = settingsAt(1);
    const session = new FieldSession<FieldSettingsDto>(
      async () => server,
      () => {},
    );
    await session.load();
    const editedFrom = session.data!;
    server = settingsAt(2);
    await session.load();
    const sent: number[] = [];
    const r = await saveSettings(
      new OwnedCommands(session),
      {
        setFieldSettings: async (c) => {
          sent.push(c.expectedN);
          if (c.expectedN !== server.settings.n)
            throw new ApiError('VERSION_CONFLICT', 409);
          return { n: c.expectedN + 1 };
        },
      },
      P,
      editedFrom,
      { selfieEnabled: true, pmProxyDays: 5 },
    );
    expect(r).toMatchObject({ kind: 'rejected', code: 'VERSION_CONFLICT' });
    expect(sent).toEqual([1]);
    expect(
      settingsCommand(
        P,
        settingsAt(3),
        { selfieEnabled: true, pmProxyDays: 5 },
        'k',
      ).expectedN,
    ).toBe(3);
  });
});

const device = (id: string, version = 1): FieldDeviceDto => ({
  id,
  personId: `p-${id}`,
  displayName: `TEST ${id}`,
  state: 'CONFIRMED',
  effectiveState: 'CONFIRMED',
  endReason: null,
  version,
  createdAt: '2026-10-01T08:00:00.000Z',
  confirmedAt: null,
  confirmedBy: null,
  lastSeenAt: '2026-10-01T08:00:00.000Z',
  expiresAt: '2027-03-30T08:00:00.000Z',
  memberUntil: null,
});
function deviceHarness() {
  const sent: { deviceId: string; key: string; settle: (e?: Error) => void }[] =
    [];
  const write =
    () =>
    (c: { deviceId: string; clientMutationId: string }): Promise<unknown> =>
      new Promise((resolve, reject) =>
        sent.push({
          deviceId: c.deviceId,
          key: c.clientMutationId,
          settle: (e) => (e ? reject(e) : resolve({})),
        }),
      );
  const api = {
    devices: async () => [device('A'), device('B')],
    revokeDevice: write(),
    rejectDevice: write(),
    confirmDevice: async () => ({}),
  };
  let n = 0;
  const commands = new DeviceCommands(
    api as never,
    P,
    () => {},
    () => `key-${++n}`,
  );
  return { commands, sent };
}
describe('#2 an unresolved device action keeps its identity', () => {
  it("another device's action cannot start or reuse it; the retry resends that action", async () => {
    const { commands, sent } = deviceHarness();
    await commands.session.load();
    const a = commands.run({ kind: 'revoke', device: device('A') });
    await tick();
    sent[0]!.settle(new ApiError('NETWORK', 0));
    expect((await a).kind).toBe('failed');
    expect(commands.unresolved).toMatchObject({
      kind: 'revoke',
      device: { id: 'A' },
    });
    expect(commands.canStart).toBe(false);
    expect(
      (await commands.run({ kind: 'revoke', device: device('B') })).kind,
    ).toBe('failed');
    expect(sent).toHaveLength(1);
    const r = commands.retry();
    await tick();
    expect(sent[1]).toMatchObject({ deviceId: 'A', key: sent[0]!.key });
    sent[1]!.settle();
    expect((await r).kind).toBe('ok');
    expect(commands.unresolved).toBeNull();
    expect(commands.canStart).toBe(true);
  });
  it('giving up clears the unresolved action and rereads', async () => {
    const { commands, sent } = deviceHarness();
    await commands.session.load();
    const a = commands.run({ kind: 'reject', device: device('A') });
    await tick();
    sent[0]!.settle(new ApiError('RETRY', 503));
    await a;
    commands.discard();
    expect(commands.unresolved).toBeNull();
    expect(commands.session.pending).toBeNull();
    expect(commands.canStart).toBe(true);
  });
});

describe('#3 a code shown after rotation is known to be current', () => {
  it('after a rotation whose rereads fail, no code is shown or printable until a reread lands', async () => {
    let current: EntryCodeDto = { code: 'A'.repeat(22), createdAt: 't1' };
    let readsFail = false;
    const session = new FieldSession<EntryCodeDto>(
      async () => {
        if (readsFail) throw new ApiError('NETWORK', 0);
        return current;
      },
      () => {},
    );
    await session.load();
    expect(qrState(session)).toMatchObject({
      kind: 'code',
      code: 'A'.repeat(22),
    });
    readsFail = true;
    const r = await session.act(() => ({
      key: 'k',
      send: async () => {
        current = { code: 'B'.repeat(22), createdAt: 't2' };
        return current;
      },
    }));
    expect(r.kind).toBe('ok');
    expect(qrState(session)).toEqual({ kind: 'stale' });
    readsFail = false;
    await session.retry();
    expect(qrState(session)).toMatchObject({
      kind: 'code',
      code: 'B'.repeat(22),
    });
  });
});

describe('#4 People-page sessions outlive the tab', () => {
  it('an unresolved command and its key survive a tab switch (same SiteSessions)', async () => {
    let n = 0;
    const sent: string[] = [];
    const api = {
      entryCode: async () => ({ code: null, createdAt: null }),
      fieldSettings: async () => settingsAt(1),
      devices: async () => [device('A')],
      revokeDevice: async (c: { clientMutationId: string }) => {
        sent.push(c.clientMutationId);
        if (++n === 1) throw new ApiError('NETWORK', 0);
        return {};
      },
    };
    const sessions = new SiteSessions(api as never, P);
    // The page mounts, the action fails, the tab is left (components gone), then reopened.
    await sessions.devices.session.load();
    await sessions.devices.run({ kind: 'revoke', device: device('A') });
    const unsubscribe = sessions.subscribe(() => {});
    unsubscribe();
    expect(sessions.devices.unresolved?.device.id).toBe('A');
    await sessions.devices.retry();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
  });
});
