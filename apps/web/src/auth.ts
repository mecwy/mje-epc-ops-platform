import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
} from '@azure/msal-browser';
import type { AuthConfig } from './api.js';
import {
  chooseInteraction,
  clearStaleInteraction,
  type Interaction,
} from './signin.js';

export type AuthClient = Pick<
  PublicClientApplication,
  | 'handleRedirectPromise'
  | 'getActiveAccount'
  | 'setActiveAccount'
  | 'getAllAccounts'
  | 'loginRedirect'
  | 'loginPopup'
  | 'acquireTokenSilent'
  | 'acquireTokenRedirect'
  | 'logoutRedirect'
  | 'logoutPopup'
>;
export interface AuthEnv {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  interaction: () => Interaction;
}

/** A sign-in error that carries an MSAL-style code (see signInFailure). */
class AuthCodeError extends Error {
  constructor(readonly errorCode: string) {
    super(errorCode);
  }
}

/**
 * Signs in with Microsoft Entra by full-page redirect (popup only as the embedded-desktop
 * fallback, see chooseInteraction); tokens stay in MSAL's session storage.
 */
export class EntraAuth {
  private popupOpen = false;
  private readonly expiredListeners = new Set<() => void>();

  private constructor(
    private readonly client: AuthClient,
    private readonly scope: string,
    private readonly clientId: string,
    private readonly env: AuthEnv,
    /** Why the redirect this page returned from failed; null if none. */
    readonly redirectError: unknown,
  ) {}

  static async create(config: AuthConfig): Promise<EntraAuth> {
    if (
      !config.enabled ||
      !config.tenantId ||
      !config.clientId ||
      !config.scope
    )
      throw new Error('AUTH_NOT_CONFIGURED');
    const client = new PublicClientApplication({
      auth: {
        clientId: config.clientId,
        authority: `https://login.microsoftonline.com/${config.tenantId}`,
        redirectUri: window.location.origin + '/',
        postLogoutRedirectUri: window.location.origin + '/',
      },
      cache: { cacheLocation: 'sessionStorage' },
    });
    await client.initialize();
    return EntraAuth.start(client, config.scope, config.clientId, {
      storage: sessionStore(),
      interaction: () =>
        chooseInteraction({
          embedded: window.self !== window.top,
          finePointer: window.matchMedia('(pointer: fine)').matches,
        }),
    });
  }

  /** Completes a redirect this page returns from; its account becomes the active one. */
  static async start(
    client: AuthClient,
    scope: string,
    clientId: string,
    env: AuthEnv,
  ): Promise<EntraAuth> {
    let redirectError: unknown = null;
    try {
      const result = await client.handleRedirectPromise();
      if (result?.account) client.setActiveAccount(result.account);
    } catch (error) {
      redirectError = error;
    }
    return new EntraAuth(client, scope, clientId, env, redirectError);
  }

  current(): AccountInfo | null {
    const active = this.client.getActiveAccount();
    if (active) return active;
    const accounts = this.client.getAllAccounts();
    if (accounts.length !== 1) return null;
    return accounts[0] ?? null;
  }

  /** Called once a token can no longer be renewed without the user. */
  onExpired(listener: () => void): () => void {
    this.expiredListeners.add(listener);
    return () => this.expiredListeners.delete(listener);
  }

  /**
   * Redirect: resolves null and the page leaves for Microsoft. Popup (embedded desktop only):
   * resolves with the account.
   */
  async signIn(): Promise<AccountInfo | null> {
    const request = { scopes: [this.scope], prompt: 'select_account' };
    this.beginInteraction();
    if (this.env.interaction() === 'redirect') {
      await this.client.loginRedirect(request);
      return null;
    }
    this.popupOpen = true;
    try {
      const result = await this.client.loginPopup(request);
      if (!result.account) throw new Error('LOGIN_REQUIRED');
      this.client.setActiveAccount(result.account);
      return result.account;
    } finally {
      this.popupOpen = false;
    }
  }

  /** Silent renewal; when the user is needed it reports expiry and never opens a popup. */
  async token(account: AccountInfo): Promise<string> {
    try {
      const result = await this.client.acquireTokenSilent({
        scopes: [this.scope],
        account,
      });
      return result.accessToken;
    } catch (error) {
      if (error instanceof InteractionRequiredAuthError) {
        this.expiredListeners.forEach((fn) => fn());
        throw new Error('LOGIN_REQUIRED', { cause: error });
      }
      throw error;
    }
  }

  /** Sign in again after expiry: always a full-page redirect. */
  async renew(account: AccountInfo): Promise<void> {
    this.beginInteraction();
    await this.client.acquireTokenRedirect({ scopes: [this.scope], account });
  }

  /** Resolves true when the page is leaving (redirect), false when it should reload. */
  async signOut(account: AccountInfo): Promise<boolean> {
    if (this.env.interaction() === 'popup') {
      await this.client.logoutPopup({ account });
      return false;
    }
    await this.client.logoutRedirect({ account });
    return true;
  }

  /** A user-started attempt: refuse while our popup is open, else clear a stale lock. */
  private beginInteraction() {
    if (this.popupOpen) throw new AuthCodeError('interaction_in_progress');
    if (this.env.storage)
      clearStaleInteraction(this.env.storage, this.clientId);
  }
}

function sessionStore(): AuthEnv['storage'] {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

const DEV_TOKEN = 'mje-dev-token';
/**
 * Local development only: a token from scripts/dev-report-server.mjs, passed as #dev-token=…
 * Vite replaces import.meta.env.DEV with false in production builds, so this code and the
 * storage key are removed from the bundle (checked by scripts/check-web-bundle.mjs).
 */
export function devToken(): string | null {
  if (!import.meta.env.DEV) return null;
  const match = /^#dev-token=([\w.-]+)$/.exec(window.location.hash);
  try {
    if (match?.[1]) {
      sessionStorage.setItem(DEV_TOKEN, match[1]);
      history.replaceState(null, '', window.location.pathname);
    }
    return sessionStorage.getItem(DEV_TOKEN);
  } catch {
    return match?.[1] ?? null;
  }
}
