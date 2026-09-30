// Post-deploy smoke check that needs no sign-in:
//   node scripts/dev-smoke.mjs <https base URL> <expected source revision>
// Checks /health/live reports the expected revision within 40 s (cold start included), every
// script and stylesheet the page references loads, /api/auth-config is enabled, and business
// routes refuse a request without a token (401). Prints one JSON summary line; exit 1 on any
// failure. Never sends credentials.
const [base, expected] = process.argv.slice(2);
if (
  !base ||
  !/^https:\/\/[a-z0-9.-]+$/i.test(base.replace(/\/$/, '')) ||
  !expected
)
  throw new Error('usage: dev-smoke.mjs <https base URL> <expected revision>');
const url = (p) => new URL(p, base).toString();
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });
const get = async (p, init = {}) => {
  const r = await fetch(url(p), {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });
  return {
    status: r.status,
    type: r.headers.get('content-type') ?? '',
    text: await r.text(),
  };
};

// 1. health, allowing a cold start
const started = Date.now();
let health = null;
while (Date.now() - started < 40_000) {
  try {
    const r = await get('/health/live');
    if (r.status === 200) {
      health = JSON.parse(r.text);
      if (String(health.revision).startsWith(expected)) break;
    }
  } catch {
    // not up yet
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
const seconds = Math.round((Date.now() - started) / 1000);
check(
  'health reports the expected revision within 40 s',
  health?.status === 'ok' &&
    String(health?.revision ?? '').startsWith(expected),
  `revision ${String(health?.revision ?? 'none').slice(0, 7)} after ${seconds}s`,
);

// 2. page and its static assets
const page = await get('/');
check(
  'page loads',
  page.status === 200 && page.type.includes('text/html'),
  `status ${page.status}`,
);
const assets = [...page.text.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(
  (m) => m[1],
);
check(
  'page references built assets',
  assets.length > 0,
  `${assets.length} assets`,
);
for (const a of assets) {
  const r = await get(a);
  check(`asset ${a.split('/').pop()}`, r.status === 200, `status ${r.status}`);
}

// 3. sign-in configuration (public by design; no secret)
const cfg = await get('/api/auth-config');
let config = {};
try {
  config = JSON.parse(cfg.text);
} catch {
  // reported below
}
check(
  'auth config is enabled',
  cfg.status === 200 &&
    config.enabled === true &&
    typeof config.clientId === 'string',
  `status ${cfg.status}`,
);

// 4. business routes refuse a request without a token
for (const p of [
  '/api/report/projects',
  '/api/report/day?projectId=00000000-0000-4000-8000-000000000000&businessDate=2026-01-01',
  '/api/report/photos?projectId=00000000-0000-4000-8000-000000000000&businessDate=2026-01-01',
]) {
  const r = await get(p);
  check(
    `no token → 401 ${p.split('?')[0]}`,
    r.status === 401,
    `status ${r.status}`,
  );
}

const failed = results.filter((r) => !r.ok);
console.log(
  JSON.stringify({
    ok: failed.length === 0,
    revision: expected.slice(0, 7),
    checks: results.length,
    failed,
  }),
);
process.exit(failed.length ? 1 : 0);
