import { describe, expect, it, vi } from 'vitest';
import {
  InteractionRequiredAuthError,
  type AccountInfo,
} from '@azure/msal-browser';
import { EntraAuth, type AuthClient } from './auth.js';
import { INTERACTION_KEY, type Interaction } from './signin.js';

const account = (id: string) => ({ homeAccountId: id }) as AccountInfo;

function fakeClient(over: Partial<Record<keyof AuthClient, unknown>> = {}) {
  let active: AccountInfo | null = null;
  const client = {
    handleRedirectPromise: vi.fn(async () => null),
    getActiveAccount: vi.fn(() => active),
    setActiveAccount: vi.fn((a: AccountInfo | null) => {
      active = a;
    }),
    getAllAccounts: vi.fn(() => [] as AccountInfo[]),
    loginRedirect: vi.fn(async () => {}),
    loginPopup: vi.fn(async () => ({ account: account('popup') })),
    acquireTokenSilent: vi.fn(async () => ({ accessToken: 'at' })),
    acquireTokenRedirect: vi.fn(async () => {}),
    logoutRedirect: vi.fn(async () => {}),
    logoutPopup: vi.fn(async () => {}),
    ...over,
  };
  return client;
}
function store(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}
const start = (
  client: ReturnType<typeof fakeClient>,
  interaction: Interaction = 'redirect',
  storage = store(),
) =>
  EntraAuth.start(client as unknown as AuthClient, 'api://x/.default', 'app', {
    storage,
    interaction: () => interaction,
  });

describe('EntraAuth (redirect sign-in)', () => {
  it('lands signed in with the account of a completed redirect', async () => {
    const a = account('a');
    const client = fakeClient({
      handleRedirectPromise: vi.fn(async () => ({ account: a })),
      // Two cached accounts: without the active account the app could not pick one.
      getAllAccounts: vi.fn(() => [account('old'), a]),
    });
    const auth = await start(client);
    expect(client.setActiveAccount).toHaveBeenCalledWith(a);
    expect(auth.current()).toBe(a);
    expect(auth.redirectError).toBeNull();
  });

  it('keeps a failed redirect as an error to show instead of failing to start', async () => {
    const failure = Object.assign(new Error('x'), {
      errorCode: 'user_cancelled',
    });
    const client = fakeClient({
      handleRedirectPromise: vi.fn(async () => {
        throw failure;
      }),
    });
    const auth = await start(client);
    expect(auth.redirectError).toBe(failure);
    expect(auth.current()).toBeNull();
  });

  it('signs in with loginRedirect, never a popup, on phones and desktop tabs', async () => {
    const client = fakeClient();
    const auth = await start(client);
    await expect(auth.signIn()).resolves.toBeNull();
    expect(client.loginRedirect).toHaveBeenCalledWith({
      scopes: ['api://x/.default'],
      prompt: 'select_account',
    });
    expect(client.loginPopup).not.toHaveBeenCalled();
  });

  it('clears a stale interaction lock of this app before a new attempt', async () => {
    const s = store({
      [INTERACTION_KEY]: JSON.stringify({ clientId: 'app', type: 'signin' }),
    });
    const client = fakeClient({
      loginRedirect: vi.fn(async () => {
        expect(s.data.has(INTERACTION_KEY)).toBe(false);
      }),
    });
    const auth = await start(client, 'redirect', s);
    await auth.signIn();
    expect(client.loginRedirect).toHaveBeenCalledOnce();
  });

  it('uses the popup only as the embedded-desktop fallback, one at a time', async () => {
    let release = () => {};
    const client = fakeClient({
      loginPopup: vi.fn(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ account: account('p') });
          }),
      ),
    });
    const auth = await start(client, 'popup');
    const first = auth.signIn();
    await expect(auth.signIn()).rejects.toMatchObject({
      errorCode: 'interaction_in_progress',
    });
    release();
    await expect(first).resolves.toEqual(account('p'));
    expect(client.loginRedirect).not.toHaveBeenCalled();
  });

  it('on expiry reports it and renews by redirect, never by popup', async () => {
    const client = fakeClient({
      acquireTokenSilent: vi.fn(async () => {
        throw new InteractionRequiredAuthError('interaction_required');
      }),
    });
    const auth = await start(client, 'popup');
    const expired = vi.fn();
    auth.onExpired(expired);
    const a = account('a');
    await expect(auth.token(a)).rejects.toThrow('LOGIN_REQUIRED');
    expect(expired).toHaveBeenCalledOnce();
    await auth.renew(a);
    expect(client.acquireTokenRedirect).toHaveBeenCalledWith({
      scopes: ['api://x/.default'],
      account: a,
    });
    expect(client.loginPopup).not.toHaveBeenCalled();
  });
});
