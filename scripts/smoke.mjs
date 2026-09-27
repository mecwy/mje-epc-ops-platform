import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const api = spawn(process.execPath, ['apps/api/dist/main.js'], {
  stdio: 'pipe',
});
const preview = spawn(
  process.execPath,
  [
    'node_modules/vite/bin/vite.js',
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    '5178',
    '--strictPort',
  ],
  { cwd: process.cwd() + '/apps/web', stdio: 'pipe' },
);
const worker = spawn(process.execPath, ['apps/worker/dist/main.js'], {
  stdio: 'pipe',
});
let workerLog = '';
worker.stdout.on('data', (d) => (workerLog += d));
async function ready(url) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
    } catch {
      // Wait for the local process to bind its port.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Not ready: ' + url);
}
try {
  const health = await (
    await ready('http://127.0.0.1:3300/health/live')
  ).json();
  assert.equal(health.phase, 'phase-0');
  const html = await (await ready('http://127.0.0.1:5178')).text();
  assert.match(html, /MJE/);
  await new Promise((r) => setTimeout(r, 200));
  assert.match(workerLog, /boot-ok-no-jobs/);
  console.log(
    'PASS API HTTP health; Vite built page HTTP; Worker boot/exit. No business UI or authentication claimed.',
  );
} finally {
  api.kill();
  preview.kill();
  worker.kill();
}
