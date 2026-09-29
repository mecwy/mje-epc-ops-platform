import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
} from '@azure/msal-browser';
import type { AuthConfig } from './api.js';

/** Signs in with Microsoft Entra (MSAL popup); tokens stay in session storage. */
export class EntraAuth {
  private constructor(
    private readonly client: PublicClientApplication,
    private readonly scope: string,
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
    await client.handleRedirectPromise();
    return new EntraAuth(client, config.scope);
  }

  current(): AccountInfo | null {
    const accounts = this.client.getAllAccounts();
    if (accounts.length !== 1) return null;
    return accounts[0] ?? null;
  }

  async signIn(): Promise<AccountInfo> {
    const result = await this.client.loginPopup({
      scopes: [this.scope],
      prompt: 'select_account',
    });
    if (!result.account) throw new Error('LOGIN_REQUIRED');
    this.client.setActiveAccount(result.account);
    return result.account;
  }

  async token(account: AccountInfo): Promise<string> {
    try {
      const result = await this.client.acquireTokenSilent({
        scopes: [this.scope],
        account,
      });
      return result.accessToken;
    } catch (error) {
      if (error instanceof InteractionRequiredAuthError)
        throw new Error('LOGIN_REQUIRED', { cause: error });
      throw error;
    }
  }

  async signOut(account: AccountInfo): Promise<void> {
    await this.client.logoutPopup({ account });
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
