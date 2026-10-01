// @ts-check
import { execFileSync } from 'node:child_process';
import {
  isAllowedPublicPath,
  hasCredentialPattern,
  parseStageRecord,
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
  const record = parseStageRecord(entry);
  if (!record) {
    failures.push('an index record without a path; inspect locally');
    continue;
  }
  const { mode, stage, path } = record;
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
