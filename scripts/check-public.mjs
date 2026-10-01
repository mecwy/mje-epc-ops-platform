// @ts-check
import { execFileSync } from 'node:child_process';
import {
  isAllowedPublicPath,
  hasCredentialPattern,
} from './publication-policy.mjs';

const git = (/** @type {string[]} */ ...args) =>
  execFileSync('git', args, { maxBuffer: 8 * 1024 * 1024 });
const allowlist = new Set(
  JSON.parse(git('show', ':public-files.json').toString()),
);
const entries = git('ls-files', '--stage', '-z')
  .toString()
  .split('\0')
  .filter(Boolean);
const failures = [];
for (const entry of entries) {
  // git ls-files --stage: '<mode> <object> <stage>\t<path>'. Only the first two parts are read;
  // a path containing a tab splits further (known defect, listed on PR #56; fixed separately).
  const [metadata, path] = /** @type {[string, string, ...string[]]} */ (
    entry.split('\t')
  );
  const [mode, , stage] = metadata.split(' ');
  if (mode !== '100644' && mode !== '100755') {
    failures.push(`${path}: symlink/submodule or unsupported mode`);
    continue;
  }
  if (stage !== '0' || !isAllowedPublicPath(path, allowlist)) {
    failures.push(`${path}: not approved for publication`);
    continue;
  }
  const content = git('show', `:${path}`);
  if (content.includes(0) || hasCredentialPattern(content.toString())) {
    failures.push(`${path}: binary or possible credential; inspect locally`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Public index guard: ${entries.length} reviewed paths; manual review still required.`,
  );
}
