import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FieldSettingsDto } from '@mje/contracts';
import { ApiError, type Project } from '../api.js';
import { I18nProvider } from '../i18n.js';
import { SettingsCards } from './Settings.js';
import {
  SiteSessions,
  saveSettings,
  saveSiteReference,
} from './site-sessions.js';

const P = '11111111-1111-4111-8111-111111111111';
const project: Project = {
  id: P,
  name: 'TEST',
  code: 'TEST',
  timezone: 'Europe/Belgrade',
  access: 'write',
};
// Server state: selfie off, 7 days; site at the TEST point 1/1, radius 500.
const server: FieldSettingsDto = {
  projectId: P,
  siteReference: { n: 1, lat: '1.000000', lon: '1.000000', radiusM: 500 },
  settings: { n: 1, selfieEnabled: false, pmProxyDays: 7 },
};
const sent: unknown[] = [];
const api = {
  entryCode: async () => ({ code: null, createdAt: null }),
  devices: async () => [],
  fieldSettings: async () => server,
  // Every save is lost on the way (the answer never arrives).
  setFieldSettings: async (c: unknown) => {
    sent.push(c);
    throw new ApiError('NETWORK', 0);
  },
  setSiteReference: async (c: unknown) => {
    sent.push(c);
    throw new ApiError('NETWORK', 0);
  },
};
/** The People page's settings cards as they render when mounted (server-side render). */
const mount = (sessions: SiteSessions) =>
  renderToString(
    createElement(
      I18nProvider,
      null,
      createElement(SettingsCards, { api: api as never, project, sessions }),
    ),
  );

describe('#37 round 2: a form shown again shows what its Retry sends', () => {
  it('after lost saves and a tab switch (unmount, mount), the forms show the retained payloads, locked', async () => {
    const sessions = new SiteSessions(api as never, P);
    await sessions.site.load();
    await sessions.settings.load();
    // The PM edits and saves: selfie on / 5 days; site 2.000000, 2.000000, radius 300.
    await saveSettings(sessions.settingsSave, api as never, P, server, {
      selfieEnabled: true,
      pmProxyDays: 5,
    });
    await saveSiteReference(sessions.siteSave, api as never, P, server, {
      lat: '2.000000',
      lon: '2.000000',
      radiusM: 300,
    });
    expect(sent).toHaveLength(2);
    // Report tab and back: the cards mount again from the workspace's sessions.
    for (const html of [mount(sessions), mount(sessions)]) {
      expect(html).toMatch(/aria-checked="true"/);
      expect(html).toMatch(/value="5"[^>]*readOnly|readOnly[^>]*value="5"/i);
      expect(html).toContain('value="2.000000"');
      expect(html).toContain('value="300"');
      expect(html).not.toContain('value="7"');
      expect(html).not.toContain('value="500"');
      // Retry, not Save, and a way to give up.
      expect(html).toContain('Give up');
    }
  });
  it('with nothing unresolved, the forms show the server values and are editable', async () => {
    const sessions = new SiteSessions(api as never, P);
    await sessions.site.load();
    await sessions.settings.load();
    const html = mount(sessions);
    expect(html).toMatch(/aria-checked="false"/);
    expect(html).toContain('value="7"');
    expect(html).toContain('value="500"');
    expect(html).not.toMatch(/readOnly/i);
  });
});
