import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  DeclareStatusCommand,
  ProjectHomeCard,
  ProjectStatusHistoryDto,
  StatusCommandResultDto,
} from '@mje/contracts';
import { MESSAGES, translate, type MessageKey } from '@mje/ui';
import { ApiError } from '../api.js';
import { ProjectStatusSession } from './status-session.js';
import { StatusHistoryRecords, StatusPage } from './ExecutiveHome.js';

vi.mock('../i18n.js', () => ({
  useI18n: () => ({
    locale: 'en-GB',
    lang: 'en',
    t: (key: MessageKey, vars?: Record<string, string | number>) =>
      Object.hasOwn(MESSAGES, key) ? translate('en', key, vars) : key,
  }),
}));
const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const card: ProjectHomeCard = {
  id: projectId,
  code: 'TEST-STATUS',
  name: 'TEST Project',
  timezone: 'Europe/Belgrade',
  region: null,
  projectType: null,
  managers: [{ personId: 'TEST-person', displayName: 'TEST Manager' }],
  status: {
    value: 'NORMAL',
    declaredStatus: 'NORMAL',
    declaredAt: '2026-10-05T10:00:00Z',
    businessDate: '2026-10-05',
    staleDays: null,
  },
  completion: { state: 'NOT_COMPUTABLE' },
  forecast: { state: 'NOT_COMPUTABLE' },
  hints: [],
  reportsLast7: [],
};
function fixture() {
  let now = new Date('2026-10-06T10:00:00Z');
  let loseAck = false;
  let revoke = false;
  const history: ProjectStatusHistoryDto = {
    projectId,
    currentN: 3,
    updates: [
      {
        id: 'TEST-status-3',
        n: 3,
        status: 'NORMAL',
        areas: [],
        situation: 'TEST recorded situation',
        recovery: '',
        expectedRecoveryDate: null,
        expectedRecoveryUnknown: false,
        needsSupport: false,
        supportNote: '',
        declaredAt: '2026-10-05T10:00:00Z',
        businessDate: '2026-10-05',
        siteTimezone: 'Europe/Belgrade',
        declaredBy: 'TEST-account',
        declaredByPersonId: 'TEST-person',
        notes: [
          {
            id: 'TEST-note',
            text: 'TEST retained reply',
            byAccountId: 'TEST-reader',
            byPersonId: 'TEST-reader-person',
            at: '2026-10-05T11:00:00Z',
          },
        ],
      },
    ],
  };
  const sent: DeclareStatusCommand[] = [];
  const replay = new Map<string, StatusCommandResultDto>();
  const api = {
    projectStatus: async () => structuredClone(history),
    declareProjectStatus: async (command: DeclareStatusCommand) => {
      sent.push(structuredClone(command));
      if (revoke) throw new ApiError('FORBIDDEN', 403);
      const prior = replay.get(command.clientMutationId);
      if (prior) return prior;
      if (command.expectedN !== history.currentN)
        throw new ApiError('VERSION_CONFLICT', 409);
      const n = ++history.currentN;
      const result = { projectId, n, statusUpdateId: `TEST-status-${n}` };
      history.updates.unshift({
        ...command,
        id: result.statusUpdateId,
        n,
        declaredAt: now.toISOString(),
        businessDate: now.toISOString().slice(0, 10),
        siteTimezone: 'Europe/Belgrade',
        declaredBy: 'TEST-account',
        declaredByPersonId: 'TEST-person',
        notes: [],
      });
      replay.set(command.clientMutationId, result);
      if (loseAck) {
        loseAck = false;
        throw new ApiError('NETWORK', 0);
      }
      return result;
    },
  };
  const session = new ProjectStatusSession(api, projectId, () => now);
  return {
    session,
    api,
    history,
    sent,
    nextDay: () => {
      now = new Date('2026-10-07T10:00:00Z');
    },
    loseAck: () => {
      loseAck = true;
    },
    revoke: () => {
      revoke = true;
    },
  };
}

describe('Read-first manager status and immutable history', () => {
  it('opening the current summary has no editor or submit form and performs no write', async () => {
    const f = fixture();
    await f.session.load();
    const html = renderToStaticMarkup(
      createElement(StatusPage, {
        api: {
          projectHome: async () => {
            throw new Error('TEST unused SSR effect');
          },
        },
        apiProjectName: card.name,
        card,
        session: f.session,
        onBack: () => {},
      }),
    );
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('<select');
    expect(html).toContain('TEST recorded situation');
    expect(html).toContain('TEST Manager');
    expect(f.sent).toHaveLength(0);
    expect(f.history.currentN).toBe(3);
  });
  it('history contains old declarations and replies but has no write controls', () => {
    const f = fixture();
    const before = structuredClone(f.history);
    const html = renderToStaticMarkup(
      createElement(StatusHistoryRecords, { history: f.history, card }),
    );
    expect(html).toContain('TEST retained reply');
    expect(html).toContain('TEST recorded situation');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<input');
    expect(f.history).toEqual(before);
    expect(f.sent).toHaveLength(0);
  });
  it('ordinary unchanged update is a no-op across days and after reopen', async () => {
    const f = fixture();
    await f.session.load();
    await f.session.publish();
    f.nextDay();
    await f.session.load();
    await f.session.publish();
    const reopened = new ProjectStatusSession(
      f.api,
      projectId,
      () => new Date('2026-10-07T10:00:00Z'),
    );
    await reopened.load();
    await reopened.publish();
    expect(f.sent).toHaveLength(0);
    expect(f.history.currentN).toBe(3);
  });
  it('explicit unchanged confirmation appends once, with the original history intact', async () => {
    const f = fixture();
    const before = structuredClone(f.history.updates[0]);
    await f.session.load();
    await Promise.all([
      f.session.confirmUnchanged(),
      f.session.confirmUnchanged(),
    ]);
    await f.session.confirmUnchanged();
    await f.session.publish();
    expect(f.sent).toHaveLength(1);
    expect(f.history.currentN).toBe(4);
    expect(f.history.updates[0]?.businessDate).toBe('2026-10-06');
    expect(f.history.updates[1]).toEqual(before);
  });
  it('cancel discards only unsaved input and refresh/reopen never publishes', async () => {
    const f = fixture();
    const before = structuredClone(f.history);
    await f.session.load();
    f.session.edit({ situation: 'TEST unsaved edit' });
    expect(f.session.cancelEditing()).toBe(true);
    await f.session.load();
    await f.session.publish();
    expect(f.session.draft?.situation).toBe('TEST recorded situation');
    expect(f.history).toEqual(before);
    expect(f.sent).toHaveLength(0);
  });
  it('explicit confirmation with lost receipt retries the same payload and key only', async () => {
    const f = fixture();
    await f.session.load();
    f.loseAck();
    await f.session.confirmUnchanged();
    expect(f.session.cancelEditing()).toBe(false);
    await f.session.publish();
    await f.session.confirmUnchanged();
    expect(f.sent).toHaveLength(1);
    await f.session.retry();
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toEqual(f.sent[0]);
    expect(f.history.currentN).toBe(4);
  });
  it('changed content cannot use the unchanged-confirmation action', async () => {
    const f = fixture();
    await f.session.load();
    f.session.edit({ situation: 'TEST actual edit' });
    await f.session.confirmUnchanged();
    expect(f.sent).toHaveLength(0);
    await f.session.publish();
    expect(f.history.currentN).toBe(4);
    expect(f.history.updates[0]?.situation).toBe('TEST actual edit');
  });
  it('permission loss blocks an explicit confirmation and does not consume a version', async () => {
    const f = fixture();
    await f.session.load();
    f.revoke();
    await f.session.confirmUnchanged();
    expect(f.session.permissionLost).toBe(true);
    expect(f.history.currentN).toBe(3);
    await f.session.confirmUnchanged();
    expect(f.sent).toHaveLength(1);
  });
});
