import { beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { TokenVerifier } from './token-verifier.js';

// TEST identities, keys and claims generated only for isolated cryptographic checks.
const tenantId = '00000000-0000-4000-8000-000000000001';
const audience = '00000000-0000-4000-8000-000000000002';
const clientId = '00000000-0000-4000-8000-000000000003';
const objectId = '00000000-0000-4000-8000-000000000004';
let privateKey: CryptoKey;
let verifier: TokenVerifier;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  verifier = new TokenVerifier(
    { tenantId, audience, clientId, scope: 'access_as_user' },
    createLocalJWKSet({
      keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256' }],
    }),
  );
});
async function token(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return (
    'Bearer ' +
    (await new SignJWT({
      iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      aud: audience,
      tid: tenantId,
      oid: objectId,
      sub: 'TEST-subject',
      azp: clientId,
      scp: 'access_as_user',
      ver: '2.0',
      iat: now,
      nbf: now - 1,
      exp: now + 300,
      ...overrides,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .sign(privateKey))
  );
}
describe('Entra access-token boundary', () => {
  it('returns only verified tenant/object identity; ignores client org/role/email claims', async () => {
    expect(
      await verifier.verify(
        await token({
          orgId: 'TEST-forged-org',
          role: 'Admin',
          email: 'test@example.invalid',
        }),
      ),
    ).toEqual({ tenantId, objectId });
  });
  it.each([
    { iss: 'https://example.invalid/v2.0' },
    { aud: clientId },
    { tid: clientId },
    { azp: audience },
    { exp: 1 },
    { nbf: 9999999999 },
    { ver: '1.0' },
    { scp: 'other_scope' },
    { oid: 'not-an-object-id' },
    { idtyp: 'app' },
    { scp: undefined },
    { exp: undefined },
  ])('rejects invalid claims: %j', async (claims) => {
    await expect(verifier.verify(await token(claims))).rejects.toThrow();
  });
  it('rejects tampering and missing bearer authentication', async () => {
    const original = await token();
    const parts = original.split('.');
    parts[1] = Buffer.from(
      JSON.stringify({ oid: objectId, role: 'Admin' }),
    ).toString('base64url');
    await expect(verifier.verify(parts.join('.'))).rejects.toThrow();
    await expect(verifier.verify(undefined)).rejects.toThrow();
    await expect(verifier.verify('Basic test')).rejects.toThrow();
  });
  it('refuses an arbitrary discovery host or missing deployment identifiers', () => {
    expect(
      () =>
        new TokenVerifier({
          tenantId: 'https://example.invalid',
          audience,
          clientId,
          scope: 'access_as_user',
        }),
    ).toThrow();
  });
});
