import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
} from '@azure/msal-browser';
import type { AuthConfig } from './alpha-api.js';

export class AlphaAuth {
  private constructor(
    private readonly client: PublicClientApplication,
    private readonly scope: string,
  ) {}

  static async create(config: AuthConfig): Promise<AlphaAuth> {
    if (
      !config.enabled ||
      !config.tenantId ||
      !config.clientId ||
      !config.scope
    )
      throw new Error('ALPHA_NOT_CONFIGURED');
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
    return new AlphaAuth(client, config.scope);
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
