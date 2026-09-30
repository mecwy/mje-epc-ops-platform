import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RosterDto } from '@mje/contracts';
import { ApiError, type Project } from '../api.js';
import { I18nProvider } from '../i18n.js';
import { ProxySheet } from './CheckIns.js';
import { SiteSessions } from './site-sessions.js';

const P = '11111111-1111-4111-8111-111111111111';
const project: Project = {
  id: P,
  name: 'TEST',
  code: 'TEST',
  timezone: 'Europe/Belgrade',
  access: 'write',
};
const wrap = (el: ReturnType<typeof createElement>) =>
  renderToString(createElement(I18nProvider, null, el));

describe('A6d-4 follows the rule: form state = the owned command payload', () => {
  it('an unresolved PM proxy shows its payload only (no inputs), DAY precision as "whole day"', async () => {
    const roster: RosterDto = {
      projectId: P,
      rosterVersion: 1,
      crews: [],
      assignments: [
        {
          id: 'a',
          crewId: 'c',
          personId: 'w',
          displayName: 'TEST worker',
          role: 'MEMBER',
          validFrom: '2026-09-01T00:00:00.000Z',
          validUntil: null,
        },
      ],
    };
    const sent: unknown[] = [];
    const api = {
      entryCode: async () => ({ code: null, createdAt: null }),
      devices: async () => [],
      fieldSettings: async () => null,
      roster: async () => roster,
      checkIns: async () => ({
        projectId: P,
        businessDate: '2026-10-02',
        seqBoundary: null,
        summary: { present: 0, self: 0, proxy: 0, flagged: 0 },
        checkIns: [],
      }),
      pmProxy: async (c: unknown) => {
        sent.push(c);
        throw new ApiError('NETWORK', 0);
      },
    };
    const s = new SiteSessions(api as never, P);
    await s.roster.load();
    const day = s.checkIns('2026-10-02');
    await day.list.load();
    const command = {
      projectId: P,
      personId: 'w',
      businessDate: '2026-10-01',
      occurredAt: null,
      source: 'FOREMAN_REPORTED' as const,
      reason: 'TEST reason',
      actorFix: null,
    };
    // As ProxySheet builds it: the body is fixed once for its key.
    await day.proxy.run(command, (_d, key) => {
      const body = { ...command, clientMutationId: key };
      return { key, send: () => api.pmProxy(body) };
    });
    const html = wrap(
      createElement(ProxySheet, {
        api: api as never,
        project,
        sessions: s,
        date: '2026-10-02',
        onClose: () => {},
      }),
    );
    expect(html).not.toMatch(/<input|<select|<textarea/);
    expect(html).toContain('TEST worker');
    expect(html).toContain('TEST reason');
    expect(html).toMatch(/whole day/);
    await day.proxy.retry();
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[1])).toBe(JSON.stringify(sent[0]));
  });
});
