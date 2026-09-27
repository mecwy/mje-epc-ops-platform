import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isAllowedPublicPath,
  hasCredentialPattern,
} from './publication-policy.mjs';

test('new paths require explicit review', () => {
  const allow = new Set(['apps/api/src/main.ts']);
  assert.equal(isAllowedPublicPath('apps/api/src/main.ts', allow), true);
  assert.equal(
    isAllowedPublicPath('apps/api/src/customer-export.json', allow),
    false,
  );
});
test('an allowlist entry cannot bypass private data exclusions', () => {
  for (const path of [
    '.env',
    'apps/api/.env.production',
    'docs/requirements/example.md',
    'private/data.json',
    'photo.JPG',
    'report.docx',
    'backup.zip',
  ]) {
    assert.equal(isAllowedPublicPath(path, new Set([path])), false);
  }
});
test('local emulator example can be reviewed without permitting real env files', () => {
  assert.equal(
    isAllowedPublicPath('.env.example', new Set(['.env.example'])),
    true,
  );
});
test('common credential forms are detected without recording real secrets', () => {
  const synthetic = [
    'ghp_' + 'x'.repeat(24),
    '-----BEGIN ' + 'PRIVATE KEY-----',
    'https://example.invalid/blob?sig=' + 'x'.repeat(24),
  ];
  for (const value of synthetic)
    assert.equal(hasCredentialPattern(value), true);
  assert.equal(
    hasCredentialPattern('AZURE_CLIENT_ID: ${{ vars.AZURE_CLIENT_ID }}'),
    false,
  );
});
