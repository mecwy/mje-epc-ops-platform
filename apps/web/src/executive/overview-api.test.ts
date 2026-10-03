import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAddStatusNoteCommand } from '@mje/contracts';
import { reportApi } from '../api.js';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  key = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
afterEach(() => vi.unstubAllGlobals());
describe('overview boundary adapters', () => {
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
