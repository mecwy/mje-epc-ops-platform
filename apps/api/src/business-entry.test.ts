import type { INestApplication } from '@nestjs/common';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';

describe('business workspace entry on the packaged HTTP application', () => {
  let app: INestApplication;
  let root: string;
  let base: string;
  const html = '<html><body>TEST signed-in application shell</body></html>';

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'mje-business-entry-TEST-'));
    mkdirSync(join(root, 'field'));
    writeFileSync(join(root, 'index.html'), html);
    writeFileSync(
      join(root, 'field/index.html'),
      '<html>TEST field page</html>',
    );
    vi.stubEnv('WEB_ROOT', root);
    app = await createApp(undefined, { installSignalHandlers: false });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterAll(async () => {
    if (app) await app.close();
    vi.unstubAllEnvs();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it.each(['/contracts', '/opportunities', '/opportunities?view=mine'])(
    'serves the existing application shell at %s without enabling login',
    async (path) => {
      const response = await fetch(base + path);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-security-policy')).toContain(
        "frame-ancestors 'none'",
      );
      expect(await response.text()).toBe(html);
      const config = await fetch(base + '/api/auth-config');
      expect(await config.json()).toEqual({ enabled: false });
    },
  );

  it.each(['/contracts', '/opportunities'])(
    'supports HEAD at %s without a response body',
    async (path) => {
      const response = await fetch(base + path, { method: 'HEAD' });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe('');
    },
  );

  it.each([
    '/unknown',
    '/contracts/missing',
    '/opportunities/missing',
    '/.env',
    '/.git/config',
    '/src/main.ts',
    '/api/contracts',
    '/api/opportunities',
  ])(
    'does not turn %s into a public page or authorize an API',
    async (path) => {
      const response = await fetch(base + path);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('TEST signed-in');
    },
  );

  it.each(['POST', 'PUT', 'DELETE'])(
    'does not handle a %s request as a workspace page',
    async (method) => {
      for (const path of ['/contracts', '/opportunities']) {
        const response = await fetch(base + path, { method });
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain('TEST signed-in');
      }
    },
  );

  it('keeps the existing root and field pages', async () => {
    const index = await fetch(base + '/');
    expect(index.status).toBe(200);
    expect(await index.text()).toBe(html);
    const field = await fetch(base + '/field/');
    expect(field.status).toBe(200);
    expect(await field.text()).toContain('TEST field page');
  });

  it('does not expose workspace pages when no web build is configured', async () => {
    vi.stubEnv('WEB_ROOT', undefined);
    const apiOnly = await createApp(undefined, {
      installSignalHandlers: false,
    });
    try {
      await apiOnly.listen(0, '127.0.0.1');
      const url = await apiOnly.getUrl();
      for (const path of ['/contracts', '/opportunities']) {
        const response = await fetch(url + path);
        expect(response.status).toBe(404);
      }
    } finally {
      await apiOnly.close();
      vi.stubEnv('WEB_ROOT', root);
    }
  });
});
