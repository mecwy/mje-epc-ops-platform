import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseAddStatusNoteCommand,
  parseDeclareStatusCommand,
  requiredStatusFields,
} from '@mje/contracts';
import { reportApi } from '../api.js';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  key = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
afterEach(() => vi.unstubAllGlobals());
describe('overview boundary adapters', () => {
  it('publishes the first normal TEST declaration through the real strict API parser', async () => {
    const situation =
      'TEST A7 UAT — 状态发布验证，仅为测试，不代表真实施工判断。';
    const fetch = vi.fn(async (url: string, options: RequestInit) => {
      expect(url).toBe(`/api/projects/${A}/status`);
      let parsed;
      try {
        parsed = parseDeclareStatusCommand(JSON.parse(String(options.body)), A);
      } catch {
        return new Response(JSON.stringify({ code: 'INVALID_INPUT' }), {
          status: 400,
        });
      }
      expect(parsed.projectId).toBe(A);
      expect(parsed.expectedN).toBe(0);
      expect(parsed.situation).toBe(situation);
      expect(requiredStatusFields(parsed)).toEqual([]);
      expect(new Headers(options.headers).get('Idempotency-Key')).toBe(
        parsed.clientMutationId,
      );
      return new Response(
        JSON.stringify({ projectId: A, n: 1, statusUpdateId: key }),
      );
    });
    vi.stubGlobal('fetch', fetch);
    await expect(
      reportApi(async () => 'TEST-token').declareProjectStatus({
        projectId: A,
        expectedN: 0,
        clientMutationId: key,
        status: 'NORMAL',
        areas: [],
        situation,
        recovery: '',
        expectedRecoveryDate: null,
        expectedRecoveryUnknown: false,
        needsSupport: false,
        supportNote: '',
      }),
    ).resolves.toMatchObject({ projectId: A, n: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('uses the authenticated existing endpoint with the explicit history page', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await reportApi(async () => 'TEST-token').projectOverview(A, 3);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `/api/projects/${A}/overview?statusPage=3`,
    );
    expect(fetch.mock.calls[0]?.[1].headers.Authorization).toBe(
      'Bearer TEST-token',
    );
  });
  it('pins project and declaration in the route and sends only the strict notes DTO fields', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await reportApi(async () => 'TEST-token').addProjectStatusNote({
      projectId: A,
      n: 7,
      clientMutationId: key,
      text: ' TEST original\n',
    });
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe(`/api/projects/${A}/status/7/notes`);
    const body = JSON.parse(options.body);
    expect(body).toEqual({ clientMutationId: key, text: ' TEST original\n' });
    expect(parseAddStatusNoteCommand(body, A, 7)).toEqual({
      projectId: A,
      n: 7,
      clientMutationId: key,
      text: ' TEST original\n',
    });
    expect(options.headers['Idempotency-Key']).toBe(key);
  });
});
