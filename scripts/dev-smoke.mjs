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
const finish = () => {
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
};
const get = async (p, timeoutMs = 20_000) => {
  const r = await fetch(url(p), {
    redirect: 'manual',
    signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
  });
  return {
    status: r.status,
    type: r.headers.get('content-type') ?? '',
    text: await r.text(),
  };
};
/** A request that never throws: a transport failure becomes a failed check. */
const tryGet = async (name, p) => {
  try {
    return await get(p);
  } catch (error) {
    check(name, false, `request failed: ${error?.name ?? 'error'}`);
    return null;
  }
};

try {
  // 1. health, allowing a cold start; the 40 s deadline bounds every wait and request
  const DEADLINE = 40_000;
  const started = Date.now();
  const left = () => DEADLINE - (Date.now() - started);
  let health = null;
  while (left() > 0) {
    try {
      const r = await get('/health/live', left());
      if (r.status === 200) {
        health = JSON.parse(r.text);
        if (String(health.revision).startsWith(expected)) break;
      }
    } catch {
      // not up yet
    }
    if (left() > 0)
      await new Promise((res) => setTimeout(res, Math.min(2_000, left())));
  }
  const elapsed = Date.now() - started;
  check(
    'health reports the expected revision within 40 s',
    elapsed <= DEADLINE &&
      health?.status === 'ok' &&
      String(health?.revision ?? '').startsWith(expected),
    `revision ${String(health?.revision ?? 'none').slice(0, 7)} after ${Math.round(elapsed / 1000)}s`,
  );

  // 2. page and every script/stylesheet it references, with the right media type
  const page = await tryGet('page loads', '/');
  if (page) {
    check(
      'page loads',
      page.status === 200 && page.type.includes('text/html'),
      `status ${page.status}`,
    );
    // src/href in any quoting (double, single, none), absolute-path or relative.
    const refs = [
      ...page.text.matchAll(
        /<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>"']+))/gi,
      ),
    ]
      .map((m) => m[1] ?? m[2] ?? m[3])
      .filter((r) => !/^(?:[a-z]+:)?\/\//i.test(r) && !r.startsWith('data:'))
      .map((r) => new URL(r, url('/')).pathname);
    const assets = [
      ...new Set(refs.filter((r) => /\.(m?js|css)(\?|$)/.test(r))),
    ];
    check(
      'page references built scripts and stylesheets',
      assets.length > 0,
      `${assets.length} assets`,
    );
    for (const a of assets) {
      const name = `asset ${a.split('/').pop()}`;
      const r = await tryGet(name, a);
      if (!r) continue;
      const want = /\.css(\?|$)/.test(a) ? /text\/css/ : /javascript/;
      check(
        name,
        r.status === 200 && want.test(r.type),
        `status ${r.status} ${r.type.split(';')[0]}`,
      );
    }
  }

  // 3. sign-in configuration (public by design; no secret)
  const cfg = await tryGet('auth config is enabled', '/api/auth-config');
  if (cfg) {
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
  }

  // 4. business routes refuse a request without a token
  for (const p of [
    '/api/report/projects',
    '/api/report/day?projectId=00000000-0000-4000-8000-000000000000&businessDate=2026-01-01',
    '/api/report/photos?projectId=00000000-0000-4000-8000-000000000000&businessDate=2026-01-01',
  ]) {
    const name = `no token → 401 ${p.split('?')[0]}`;
    const r = await tryGet(name, p);
    if (r) check(name, r.status === 401, `status ${r.status}`);
  }
} catch (error) {
  check('smoke run', false, `unexpected: ${error?.name ?? 'error'}`);
}
finish();
