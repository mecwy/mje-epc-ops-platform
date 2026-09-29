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
