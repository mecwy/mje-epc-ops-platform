import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const name = `mje-test-${randomUUID()}`;
const image = `${name}:local`;
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const source = execFileSync('git', ['status', '--porcelain'], {
  encoding: 'utf8',
}).trim()
  ? `${revision}-dirty`
  : revision;
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
try {
  docker(
    'build',
    '--build-arg',
    `SOURCE_REVISION=${source}`,
    '--tag',
    image,
    '.',
  );
  docker(
    'run',
    '--detach',
    '--name',
    name,
    '--publish',
    '127.0.0.1::3300',
    image,
  );
  const port = docker('port', name, '3300/tcp').trim().split(':').at(-1);
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${base}/health/live`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* Container startup is asynchronous. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'container health must become ready');
  const health = await fetch(`${base}/health/live`);
  assert.equal((await health.json()).revision, source);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  const index = await fetch(base);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /MJE/);
  assert.match(
    index.headers.get('content-security-policy'),
    /frame-ancestors 'none'/,
  );
  for (const path of ['/contracts', '/opportunities']) {
    const entry = await fetch(base + path);
    assert.equal(entry.status, 200, `workspace entry must exist: ${path}`);
    assert.match(entry.headers.get('content-type'), /text\/html/);
    assert.equal(entry.headers.get('cache-control'), 'no-store');
    assert.match(await entry.text(), /MJE/);
  }
  const auth = await fetch(`${base}/api/auth-config`);
  assert.deepEqual(await auth.json(), { enabled: false });
  for (const path of [
    '/.env',
    '/.git/config',
    '/src/main.ts',
    '/api/site-days',
    '/unknown',
  ]) {
    assert.equal(
      (await fetch(base + path)).status,
      404,
      `must not expose ${path}`,
    );
  }
  assert.equal(docker('exec', name, 'id', '-u').trim(), '1000');
  console.log(
    'PASS container: same-origin page, health/source identity, private path denial, non-root user. No cloud login or business workflow claimed.',
  );
} finally {
  try {
    docker('rm', '--force', name);
  } catch {
    /* No container when the build failed. */
  }
  try {
    docker('image', 'rm', image);
  } catch {
    /* Only this TEST image is eligible. */
  }
}
