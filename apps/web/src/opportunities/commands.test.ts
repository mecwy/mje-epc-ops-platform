import { afterEach, describe, it, expect, vi } from 'vitest';
import { opportunityApi, ApiError } from '../api.js';
import { FieldSession } from '../field/session.js';
import { OwnedCommands } from '../field/owned-commands.js';
import { newDraft, freezeAction, type OpportunityAction } from './drafts.js';
const id = '11111111-1111-4111-8111-111111111111';
function action() {
  const d = newDraft('TEST account A', 'TEST person', 'create', () => id);
  d.facts.name = 'TEST original sentence';
  return freezeAction(d, id);
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('opportunity transport ownership', () => {
  it('captures one credential for identity check and write despite token source switching between awaits', async () => {
    let current = 'TEST account A token';
    const sent: RequestInit[] = [];
    vi.stubGlobal('fetch', async (path: string, options: RequestInit) => {
      sent.push(options);
      if (path.endsWith('/lookups')) {
        current = 'TEST account B token';
        return new Response(JSON.stringify({ accountId: 'TEST account A' }));
      }
      return new Response(JSON.stringify({ opportunityId: id, version: 1 }));
    });
    await opportunityApi(async () => current).sendOwned(
      'TEST account A',
      action(),
    );
    expect(sent).toHaveLength(2);
    expect((sent[0]?.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer TEST account A token',
    );
    expect((sent[1]?.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer TEST account A token',
    );
  });
  it('refuses another account before sending a write', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ accountId: 'TEST account B' }));
    });
    await expect(
      opportunityApi(async () => 'TEST token').sendOwned(
        'TEST account A',
        action(),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(urls).toEqual(['/api/opportunities/lookups']);
  });
  it('automatic retry serializes the body/key once and keeps all original values', async () => {
    vi.useFakeTimers();
    const command = action(),
      sent: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
      sent.push(options);
      if (sent.length === 1) {
        if (command.kind === 'create')
          command.body.facts.name = 'TEST mutated after transport';
        throw new Error('lost response');
      }
      return new Response(JSON.stringify({ opportunityId: id, version: 1 }));
    });
    const api = opportunityApi(async () => 'TEST token');
    const p =
      command.kind === 'create'
        ? api.create(command.body)
        : Promise.reject(new Error('fixture'));
    await vi.advanceTimersByTimeAsync(800);
    await p;
    expect(sent[0]?.body).toBe(sent[1]?.body);
    expect(JSON.parse(sent[1]!.body as string).facts.name).toBe(
      'TEST original sentence',
    );
    expect(
      (sent[1]?.headers as Record<string, string>)['Idempotency-Key'],
    ).toBe(id);
  });
  it('manual retry belongs to the unresolved action and a revoked replay preserves uncertainty', async () => {
    let refused = false;
    const first = action(),
      session = new FieldSession(
        async () => ({ accountId: 'TEST account A' }),
        () => {},
      ),
      owner = new OwnedCommands<{ accountId: string }, OpportunityAction>(
        session,
        () => id,
      ),
      bodies: string[] = [];
    const start = await owner.run(first, () => ({
      key: id,
      send: async () => {
        bodies.push(JSON.stringify(first.body));
        if (!refused) throw new ApiError('NETWORK', 0);
        throw new ApiError('FORBIDDEN', 403);
      },
    }));
    expect(start.kind).toBe('failed');
    expect(owner.current).toBe(first);
    expect(owner.canStart).toBe(false);
    refused = true;
    const result = await owner.retry();
    expect(result.kind).toBe('rejected');
    if (result.kind === 'rejected') expect(result.uncertain).toBe(true);
    expect(bodies[0]).toBe(bodies[1]);
    expect(owner.refusalUncertain).toBe(true);
  });
});
