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
export function hasCredentialPattern(text) {
  return (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) ||
    /(?:ghp_|github_pat_|gho_)[A-Za-z0-9_]{20,}/.test(text) ||
    /AKIA[0-9A-Z]{16}/.test(text) ||
    /https?:\/\/[^\s/@:]+:[^\s/@]+@/.test(text) ||
    /[?&]sig=[A-Za-z0-9%+/=]{16,}/.test(text)
  );
}
