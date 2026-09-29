import assert from 'node:assert/strict';

// node-postgres lets query parameters (host, hostaddr, service) and PG* environment variables
// override the URL host, so the check covers the effective destination, not the hostname alone.
const LOCAL = ['localhost', '127.0.0.1', '::1', '[::1]'];
const OVERRIDES = ['host', 'hostaddr', 'service'];

/** Throws unless every way node-postgres could pick a server points at this machine. */
export function assertLocalDatabase(raw, env = process.env) {
  const url = new URL(raw);
  assert.ok(
    ['postgres:', 'postgresql:'].includes(url.protocol),
    'a postgres URL is required',
  );
  for (const key of url.searchParams.keys())
    assert.ok(
      !OVERRIDES.includes(key.toLowerCase()),
      `connection override "${key}" is refused`,
    );
  assert.ok(LOCAL.includes(url.hostname), 'only a local database is accepted');
  for (const name of ['PGHOST', 'PGHOSTADDR', 'PGSERVICE'])
    assert.ok(!env[name] || LOCAL.includes(env[name]), `${name} must be local`);
  return url;
}

/** Throws unless the URL is plain local HTTP(S) on this machine, without credentials. */
export function assertLocalUrl(raw) {
  const url = new URL(raw);
  assert.ok(
    ['http:', 'https:'].includes(url.protocol),
    'an http(s) endpoint is required',
  );
  assert.ok(
    !url.username && !url.password,
    'credentials in the URL are refused',
  );
  assert.ok(LOCAL.includes(url.hostname), 'only a local endpoint is accepted');
  return url;
}

// Storage connection-string fields that choose where requests go. The SDK takes the first of a
// repeated field, so a repeated field is refused rather than guessed.
const BLOB_ROUTING = ['usedevelopmentstorage', 'developmentstorageproxyuri'];

/**
 * Throws unless a storage connection string can only reach the local blob emulator: every
 * field once, an explicit loopback BlobEndpoint, no development-storage shortcuts or proxy.
 * The caller still checks the URL of the client the SDK builds before any storage call.
 */
export function assertLocalBlob(raw) {
  const fields = new Map();
  for (const part of raw.split(';')) {
    if (!part.trim()) continue;
    const at = part.indexOf('=');
    assert.ok(at > 0, 'malformed connection string');
    const name = part.slice(0, at).trim().toLowerCase();
    assert.ok(!fields.has(name), `repeated connection field "${name}"`);
    fields.set(name, part.slice(at + 1).trim());
  }
  for (const name of BLOB_ROUTING)
    assert.ok(!fields.has(name), `connection field "${name}" is refused`);
  const endpoint = fields.get('blobendpoint');
  assert.ok(endpoint, 'an explicit BlobEndpoint is required');
  return assertLocalUrl(endpoint);
}
