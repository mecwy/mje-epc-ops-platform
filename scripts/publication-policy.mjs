// @ts-check
import { extname } from 'node:path';

const prohibitedExtensions = new Set([
  '.doc',
  '.docx',
  '.pdf',
  '.xls',
  '.xlsx',
  '.csv',
  '.zip',
  '.jpg',
  '.jpeg',
  '.png',
  '.heic',
  '.pfx',
  '.pem',
  '.key',
  '.dump',
  '.bak',
]);

/**
 * @param {string} path
 * @param {Set<string>} allowlist
 */
export function isAllowedPublicPath(path, allowlist) {
  if (!allowlist.has(path)) return false;
  if (
    path
      .split('/')
      .some((part) =>
        [
          '..',
          '.git',
          'node_modules',
          'originals',
          'private',
          'sources',
        ].includes(part),
      )
  )
    return false;
  if (path.startsWith('docs/requirements/') || path.startsWith('artifacts/'))
    return false;
  if (
    path
      .split('/')
      .some((part) => part.startsWith('.env') && part !== '.env.example')
  )
    return false;
  return !prohibitedExtensions.has(extname(path).toLowerCase());
}

// Deliberately narrow heuristics: manual content review is still required.
/** @param {string} text */
export function hasCredentialPattern(text) {
  return (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) ||
    /(?:ghp_|github_pat_|gho_)[A-Za-z0-9_]{20,}/.test(text) ||
    /AKIA[0-9A-Z]{16}/.test(text) ||
    /https?:\/\/[^\s/@:]+:[^\s/@]+@/.test(text) ||
    /[?&]sig=[A-Za-z0-9%+/=]{16,}/.test(text)
  );
}

const STAGE_RECORD =
  /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\t([\s\S]+)$/;
/**
 * One NUL-terminated record of `git ls-files --stage -z`: '<mode> <object> <stage>\t<path>'.
 * The whole record must match that grammar (six octal mode digits, a SHA-1 or SHA-256 object
 * id, stage 0–3, one tab, a non-empty path); anything else is null (never accepted). The path is
 * everything after that tab, verbatim: with -z git does not quote paths, so a path can itself
 * contain tabs or newlines.
 * @param {string} record
 * @returns {{ mode: string, object: string, stage: string, path: string } | null}
 */
export function parseStageRecord(record) {
  const m = STAGE_RECORD.exec(record);
  if (!m) return null;
  const [, mode, object, stage, path] = /** @type {string[]} */ (m);
  return {
    mode: /** @type {string} */ (mode),
    object: /** @type {string} */ (object),
    stage: /** @type {string} */ (stage),
    path: /** @type {string} */ (path),
  };
}
