// The production web bundle must not contain the local development token path
// (scripts/dev-report-server.mjs + #dev-token). Vite strips `import.meta.env.DEV` branches;
// this guard runs at the end of every web build (local, CI and Docker) and fails it if that
// ever stops being true, e.g. a build made with NODE_ENV=development.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../apps/web/dist');
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|html)$/.test(name)) files.push(p);
  }
};
walk(root);
const banned = ['mje-dev-token', 'dev-token=', 'dev-report-server'];
const hits = files.flatMap((f) => {
  const text = readFileSync(f, 'utf8');
  return banned.filter((b) => text.includes(b)).map((b) => `${f}: ${b}`);
});
if (!files.length) {
  console.error('web bundle guard: no built files; run pnpm build first');
  process.exitCode = 1;
} else if (hits.length) {
  console.error(
    `web bundle guard: development-only code in production bundle\n${hits.join('\n')}`,
  );
  process.exitCode = 1;
} else
  console.log(
    `web bundle guard: ${files.length} files, no development token path.`,
  );
