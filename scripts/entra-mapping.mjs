// Pure checks for the Dev bootstrap's Entra login mapping (no I/O, so they can be tested).
// Each returns an error message, or null when the evidence is acceptable.

// The tenant the database server trusts: Azure Database for PostgreSQL accepts an Entra
// access token only from the tenant configured on the server, so the tenant claim of the
// token the server has just accepted identifies that tenant. The token came from the managed
// identity endpoint; it is decoded here, not re-verified.
export function tokenTenant(accessToken) {
  const parts = String(accessToken ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    );
    const tid = typeof claims?.tid === 'string' ? claims.tid.toLowerCase() : '';
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      tid,
    )
      ? tid
      : null;
  } catch {
    return null;
  }
}

// 'aadauth,oid=<objectId>,type=<user|group|service>[,admin][,mfa]' — strict: the prefix
// first, exactly one oid and one type, only the known flags, nothing else.
export function parseEntraLabel(label) {
  const parts = String(label ?? '')
    .split(',')
    .map((p) => p.trim());
  if (parts[0] !== 'aadauth') return null;
  const out = { oid: null, type: null, admin: false, mfa: false };
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    const key = eq < 0 ? part : part.slice(0, eq);
    const value = eq < 0 ? null : part.slice(eq + 1);
    if ((key === 'oid' || key === 'type') && value) {
      if (out[key] !== null) return null;
      out[key] = value.toLowerCase();
    } else if ((key === 'admin' || key === 'mfa') && value === null) {
      if (out[key]) return null;
      out[key] = true;
    } else return null;
  }
  return out.oid && out.type ? out : null;
}

const off = (v) => v === 0 || v === '0' || v === false || v === 'f';

// labels: rows of pg_shseclabel for the login; listed: rows of pgaadauth_list_principals for
// the login (lower-cased keys); serverTenant: tokenTenant() of the accepted admin token.
export function checkMapping({
  labels,
  listed,
  serverTenant,
  appObjectId,
  tenantId,
}) {
  if (!serverTenant) return 'the server tenant could not be established';
  if (serverTenant !== tenantId)
    return 'the configured tenant is not the tenant of this database server';
  if (labels.length !== 1)
    return `the application login has ${labels.length} Entra labels, expected 1`;
  const label = parseEntraLabel(labels[0].label);
  if (!label)
    return 'the application login label is not a recognised Entra mapping';
  if (label.oid !== appObjectId)
    return 'the login maps to another Entra object';
  if (label.type !== 'service') return 'the login is not a service principal';
  if (label.admin) return 'the login is an Entra admin';
  if (label.mfa) return 'the login is marked MFA; a service login cannot be';
  if (listed.length > 1) return 'the login is listed more than once';
  const principal = listed[0];
  if (principal) {
    if (String(principal.objectid ?? '').toLowerCase() !== appObjectId)
      return 'the listing maps the login to another Entra object';
    if (String(principal.principaltype ?? '').toLowerCase() !== 'service')
      return 'the listing says the login is not a service principal';
    if (String(principal.tenantid ?? '').toLowerCase() !== tenantId)
      return 'the login belongs to another tenant';
    if (!off(principal.isadmin))
      return 'the listing says the login is an admin';
    if (!off(principal.ismfa)) return 'the listing says the login is MFA';
  }
  return null;
}
