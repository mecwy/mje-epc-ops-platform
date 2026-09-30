import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  FieldDeviceDto,
  FieldSettingsCommand,
  FieldSettingsDto,
} from '@mje/contracts';
import { ApiError, type Project } from '../api.js';
import { I18nProvider } from '../i18n.js';
import { ActionSheet } from './Devices.js';
import { SettingsCards } from './Settings.js';
import {
  SiteSessions,
  saveSettings,
  saveSiteReference,
} from './site-sessions.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const P = '11111111-1111-4111-8111-111111111111';
const project: Project = {
  id: P,
  name: 'TEST',
  code: 'TEST',
  timezone: 'Europe/Belgrade',
  access: 'write',
};
const at = (n: number, days: number, radiusM = 500): FieldSettingsDto => ({
  projectId: P,
  // TEST coordinates only.
  siteReference: { n, lat: '1.000000', lon: '1.000000', radiusM },
  settings: { n, selfieEnabled: false, pmProxyDays: days },
});

type Mode = 'ok' | 'lost' | 'hold' | 'hold-lost';
/**
 * A fake settings server with numbered versions (C24): a save succeeds only against the
 * current number. Reads and saves can be failed, lost or held by the test; every save is
 * logged with the number it was bound to.
 */
function server(initial: FieldSettingsDto) {
  let state = initial;
  let readsFail = false;
  const saveModes: Mode[] = [];
  const held: (() => void)[] = [];
  const log: string[] = [];
  const readHolds: ((v?: unknown) => void)[] = [];
  let holdReads = false;
  const api = {
    entryCode: async () => ({ code: null, createdAt: null }),
    devices: async () => [],
    fieldSettings: async () => {
      if (holdReads) await new Promise((r) => readHolds.push(r));
      if (readsFail) throw new ApiError('NETWORK', 0);
      return state;
    },
    setFieldSettings: async (c: FieldSettingsCommand) => {
      const mode = saveModes.shift() ?? 'ok';
      log.push(`N${c.expectedN}:${c.pmProxyDays}`);
      if (mode === 'hold' || mode === 'hold-lost')
        await new Promise<void>((r) => held.push(r));
      if (c.expectedN !== state.settings.n)
        throw new ApiError('VERSION_CONFLICT', 409);
      const lost = mode === 'lost' || mode === 'hold-lost';
      state = {
        ...state,
        settings: {
          n: state.settings.n + 1,
          selfieEnabled: c.selfieEnabled,
          pmProxyDays: c.pmProxyDays,
        },
      };
      // A lost answer: stored on the server, the reply never arrives.
      if (lost) throw new ApiError('NETWORK', 0);
      return { n: state.settings.n };
    },
    setSiteReference: async () => ({ n: 1 }),
  };
  return {
    api,
    log,
    saveModes,
    held,
    readHolds,
    state: () => state,
    otherPm: (days: number) => {
      state = {
        ...state,
        settings: {
          ...state.settings,
          n: state.settings.n + 1,
          pmProxyDays: days,
        },
      };
    },
    failReads: (v: boolean) => (readsFail = v),
    holdReads: (v: boolean) => (holdReads = v),
  };
}
const mount = (s: SiteSessions, api: unknown) =>
  renderToString(
    createElement(
      I18nProvider,
      null,
      createElement(SettingsCards, { api: api as never, project, sessions: s }),
    ),
  );
/** The settings card's HTML (the second card). */
const settingsCard = (html: string) => html.slice(html.lastIndexOf('<section'));
const edit = (s: SiteSessions, api: unknown, days: number) =>
  saveSettings(s.settingsSave, api as never, P, s.settings.data!, {
    selfieEnabled: false,
    pmProxyDays: days,
  });

describe('#37 round 3: form state = the owned command payload (single source)', () => {
  it('finding 1: a refused save never re-binds its edit to a newer version; the server keeps 11 days', async () => {
    const sv = server(at(1, 7));
    const s = new SiteSessions(sv.api as never, P);
    await s.settings.load();
    sv.otherPm(11); // another PM saves n=2, 11 days
    sv.failReads(true);
    // Edited from n=1 to 5 days: refused, and its rereads fail.
    expect(await edit(s, sv.api, 5)).toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    // Ownership ended: the form restarts from the latest read (still n=1: 7 days, not 5).
    let card = settingsCard(mount(s, sv.api));
    expect(card).toContain('value="7"');
    expect(card).not.toContain('value="5"');
    // Connectivity back; the PM types 5 again on the form edited from n=1 and saves, with
    // the answer held while a recovery read of n=2 lands.
    sv.failReads(false);
    sv.saveModes.push('hold');
    const again = edit(s, sv.api, 5);
    await tick();
    await tick();
    // While owned: no inputs, only the payload (5) and its state.
    card = settingsCard(mount(s, sv.api));
    expect(card).not.toContain('<input');
    expect(card).toContain('>5<');
    sv.held.shift()!();
    expect(await again).toMatchObject({ code: 'VERSION_CONFLICT' });
    await s.settings.load();
    // Released: the form shows the newer read (n=2, 11 days) and nothing retained.
    card = settingsCard(mount(s, sv.api));
    expect(card).toContain('value="11"');
    expect(card).not.toContain('value="5"');
    // Every 5-day save was bound to n=1; the server kept the other PM's 11 days.
    expect(sv.log).toEqual(['N1:5', 'N1:5']);
    expect(sv.state().settings.pmProxyDays).toBe(11);
  });

  it('finding 1, end state: what the mounted form would send after the sequence never overwrites 11 days', async () => {
    const sv = server(at(1, 7));
    const s = new SiteSessions(sv.api as never, P);
    await s.settings.load();
    sv.otherPm(11);
    sv.failReads(true);
    await edit(s, sv.api, 5); // refused, rereads fail
    sv.failReads(false);
    sv.saveModes.push('hold');
    // The PM saves 5 again from the form as it is mounted (edited from its own read).
    const again = saveSettings(
      s.settingsSave,
      sv.api as never,
      P,
      s.settings.data!,
      {
        selfieEnabled: false,
        pmProxyDays: 5,
      },
    );
    await tick();
    await tick();
    await s.settings.load(); // recovery read of n=2 lands while the save is held
    sv.held.shift()!();
    await again;
    await s.settings.load();
    // The form as mounted now: its days value and the read it was edited from.
    const card = settingsCard(mount(s, sv.api));
    const shown =
      /inputMode="numeric"[^>]*value="(\d+)"|value="(\d+)"[^>]*inputMode="numeric"/.exec(
        card,
      );
    const days = Number(shown?.[1] ?? shown?.[2]);
    // Pressing Save sends what is shown, against the version the form was edited from.
    await saveSettings(s.settingsSave, sv.api as never, P, s.settings.data!, {
      selfieEnabled: false,
      pmProxyDays: days,
    });
    expect(sv.state().settings.pmProxyDays).toBe(11);
  });

  // L5 matrix: owned × recovery read landing before / after × success / lost / refused ×
  // remount. In every state the mounted card either shows exactly the owned payload with no
  // inputs, or (not owned) inputs with the latest read's values.
  for (const read of ['before', 'after'] as const)
    for (const outcome of ['success', 'lost', 'refused'] as const)
      it(`recovery read lands ${read} the answer · ${outcome} · remount`, async () => {
        const sv = server(at(1, 7));
        const s = new SiteSessions(sv.api as never, P);
        await s.settings.load();
        if (outcome === 'refused') sv.otherPm(11);
        sv.saveModes.push(outcome === 'lost' ? 'hold-lost' : 'hold');
        const save = edit(s, sv.api, 5);
        await tick();
        await tick();
        if (read === 'before') await s.settings.load();
        const owned = settingsCard(mount(s, sv.api));
        expect(owned).not.toContain('<input');
        expect(owned).toContain('>5<');
        sv.held.shift()!();
        const r = await save;
        expect(r.kind).toBe(
          outcome === 'success'
            ? 'ok'
            : outcome === 'lost'
              ? 'failed'
              : 'rejected',
        );
        if (read === 'after') await s.settings.load();
        const html = settingsCard(mount(s, sv.api));
        if (outcome === 'lost') {
          // Unresolved: still exactly the payload, no inputs; Retry resends it (same n).
          expect(s.settingsSave.unresolved?.value.pmProxyDays).toBe(5);
          expect(html).not.toContain('<input');
          expect(html).toContain('>5<');
          await s.settingsSave.retry();
        } else {
          // Released: inputs with the latest read's values, nothing retained.
          const latest = s.settings.data!.settings.pmProxyDays;
          expect(s.settingsSave.current).toBeNull();
          expect(html).toContain(`value="${latest}"`);
          if (outcome === 'refused') expect(html).not.toContain('value="5"');
        }
        // Never a save bound to a version other than the one it was edited from.
        expect(sv.log.every((l) => l.startsWith('N1:'))).toBe(true);
      });

  it('a lost save shown again after a tab switch (two mounts): payload only, Retry resends it', async () => {
    const sv = server(at(1, 7));
    const s = new SiteSessions(sv.api as never, P);
    await s.settings.load();
    await s.site.load();
    sv.saveModes.push('lost');
    await edit(s, sv.api, 5);
    await saveSiteReference(
      s.siteSave,
      {
        setSiteReference: async () =>
          Promise.reject(new ApiError('NETWORK', 0)),
      },
      P,
      s.site.data!,
      { lat: '2.000000', lon: '2.000000', radiusM: 300 },
    );
    for (const html of [mount(s, sv.api), mount(s, sv.api)]) {
      expect(html).not.toContain('<input');
      expect(html).toContain('>5<');
      expect(html).toContain('>2.000000<');
      expect(html).toContain('>300<');
      expect(html).toContain('Give up');
    }
    await s.settingsSave.retry();
    expect(sv.log).toEqual(['N1:5', 'N1:5']);
  });

  it('with nothing owned, the forms show the latest read and are editable', async () => {
    const sv = server(at(1, 7));
    const s = new SiteSessions(sv.api as never, P);
    await s.settings.load();
    await s.site.load();
    const html = mount(s, sv.api);
    expect(html).toContain('value="7"');
    expect(html).toContain('value="500"');
    expect(html).toContain('<input');
  });
});

describe('#37 round 3 finding 3: an unresolved confirmation shows its own code, locked', () => {
  const device: FieldDeviceDto = {
    id: 'A',
    personId: 'pA',
    displayName: 'TEST A',
    state: 'PENDING',
    effectiveState: 'PENDING',
    endReason: null,
    version: 1,
    createdAt: '2026-10-01T08:00:00.000Z',
    confirmedAt: null,
    confirmedBy: null,
    lastSeenAt: '2026-10-01T08:00:00.000Z',
    expiresAt: '2027-03-30T08:00:00.000Z',
    memberUntil: null,
  };
  it('no code input while the confirm is unresolved; Retry resends 111111', async () => {
    const sent: string[] = [];
    const api = {
      entryCode: async () => ({ code: null, createdAt: null }),
      fieldSettings: async () => at(1, 7),
      devices: async () => [device],
      confirmDevice: async (c: { code: string }) => {
        sent.push(c.code);
        throw new ApiError('NETWORK', 0);
      },
    };
    const s = new SiteSessions(api as never, P);
    await s.devices.session.load();
    await s.devices.run({ kind: 'confirm', device, code: '111111' });
    const html = renderToString(
      createElement(
        I18nProvider,
        null,
        createElement(ActionSheet, {
          action: { kind: 'confirm', device },
          commands: s.devices,
          onClose: () => {},
        }),
      ),
    );
    expect(html).not.toContain('<input');
    expect(html).toContain('>111111<');
    await s.devices.retry();
    expect(sent).toEqual(['111111', '111111']);
  });
});
