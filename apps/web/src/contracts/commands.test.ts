import { afterEach, describe, it, expect, vi } from 'vitest';
import { contractApi, ApiError } from '../api.js';
import { FieldSession } from '../field/session.js';
import { OwnedCommands } from '../field/owned-commands.js';
import { blankDraft, freezeWrite } from './drafts.js';
import { failureKey, readFailureKey } from './messages.js';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('commercial command boundary', () => {
  it('keeps the same serialized body and key during automatic network retry', async () => {
    vi.useFakeTimers();
    const action = freezeWrite(
      blankDraft('INCOME', () => 'TEST-contract'),
      'TEST-mutation',
    );
    const sent: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
      sent.push(options);
      if (sent.length === 1) {
        action.body.revision.name = 'EDITED WHILE NETWORK FAILED';
        action.body.clientMutationId = 'EDITED-KEY';
        throw new Error('network');
      }
      return new Response(
        JSON.stringify({ contractId: 'TEST-contract', version: 1 }),
        { status: 200 },
      );
    });
    const pending =
      action.kind === 'create'
        ? contractApi(async () => 'TEST-token').create(action.body)
        : Promise.reject(new Error('fixture'));
    await vi.advanceTimersByTimeAsync(800);
    await pending;
    expect(sent).toHaveLength(2);
    expect(sent[0]!.body).toBe(sent[1]!.body);
    expect(
      (sent[1]!.headers as Record<string, string>)['Idempotency-Key'],
    ).toBe('TEST-mutation');
    expect(JSON.parse(sent[1]!.body as string).revision.name).toBe('');
  });
  it('manual retry belongs to the original correction and retains its old version and values', async () => {
    const draft = blankDraft('INCOME', () => 'TEST-contract');
    draft.version = 7;
    draft.revision.total = { state: 'VALUE', value: '0' };
    const action = freezeWrite(draft, 'TEST-key');
    const bodies: string[] = [];
    const session = new FieldSession(
      async () => ({ version: 8 }),
      () => {},
    );
    const owned = new OwnedCommands(session, () => 'TEST-key');
    const first = await owned.run(action, () => ({
      key: action.body.clientMutationId,
      send: async () => {
        bodies.push(JSON.stringify(action.body));
        if (bodies.length === 1) throw new ApiError('NETWORK', 0);
        return { version: 8 };
      },
    }));
    expect(first.kind).toBe('failed');
    expect(owned.unresolved).toBe(action);
    draft.version = 9;
    draft.revision.total.value = '99';
    expect((await owned.retry()).kind).toBe('ok');
    expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(bodies[1]!).expectedVersion).toBe(7);
  });
  it('never describes an uncertain write followed by refusal as unsaved', () => {
    expect(failureKey('FORBIDDEN', true)).toBe('ctUncertain');
    expect(failureKey('FORBIDDEN', false)).toBe('ctForbidden');
    expect(failureKey('NETWORK')).toBe('ctUncertain');
  });
  it('distinguishes a failed read from an uncertain write and from lost permission', () => {
    expect(readFailureKey('REQUEST_FAILED')).toBe('ctReadFailed');
    expect(readFailureKey('NETWORK')).toBe('ctReadFailed');
    expect(readFailureKey('FORBIDDEN')).toBe('ctForbidden');
    expect(failureKey('REQUEST_FAILED')).toBe('ctUncertain');
  });
});
