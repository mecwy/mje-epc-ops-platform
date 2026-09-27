import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface VerifiedIdentity {
  tenantId: string;
  objectId: string;
}

export interface TokenConfiguration {
  tenantId: string;
  audience: string;
  clientId: string;
  scope: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Authentication only. Every operation must subsequently resolve active membership. */
export class TokenVerifier {
  private readonly issuer: string;
  private readonly keys: JWTVerifyGetKey;

  constructor(
    private readonly config: TokenConfiguration,
    keys?: JWTVerifyGetKey,
  ) {
    if (
      !uuid.test(config.tenantId) ||
      !uuid.test(config.audience) ||
      !uuid.test(config.clientId) ||
      !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(config.scope)
    ) {
      throw new Error('Invalid authentication configuration');
    }
    this.issuer = `https://login.microsoftonline.com/${config.tenantId}/v2.0`;
    this.keys =
      keys ??
      createRemoteJWKSet(
        new URL(
          `https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`,
        ),
        { timeoutDuration: 5000, cooldownDuration: 30000 },
      );
  }

  async verify(authorization: string | undefined): Promise<VerifiedIdentity> {
    if (
      !authorization ||
      !/^Bearer [A-Za-z0-9_.-]{1,16384}$/.test(authorization)
    ) {
      throw new Error('Invalid access token');
    }
    const { payload } = await jwtVerify(authorization.slice(7), this.keys, {
      algorithms: ['RS256'],
      issuer: this.issuer,
      audience: this.config.audience,
      requiredClaims: [
        'exp',
        'iat',
        'nbf',
        'sub',
        'tid',
        'oid',
        'azp',
        'scp',
        'ver',
      ],
      clockTolerance: 5,
    });
    if (
      payload['tid'] !== this.config.tenantId ||
      payload['ver'] !== '2.0' ||
      payload['azp'] !== this.config.clientId ||
      typeof payload['oid'] !== 'string' ||
      !uuid.test(payload['oid']) ||
      typeof payload['scp'] !== 'string' ||
      !payload['scp'].split(' ').includes(this.config.scope) ||
      payload['idtyp'] === 'app'
    ) {
      throw new Error('Invalid access token');
    }
    return { tenantId: this.config.tenantId, objectId: payload['oid'] };
  }
}
