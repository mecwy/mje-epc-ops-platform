import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { publicAssets } from './public-assets.js';

describe('public build asset HTTP boundary', () => {
  let root: string;
  let server: Server;
  let base: string;
  const javascript = 'export const test = "TEST public asset";\n'.repeat(200);
  const request = (
    path: string,
    headers: Record<string, string> = {},
    method = 'GET',
  ) =>
    new Promise<{
      status: number;
      headers: import('node:http').IncomingHttpHeaders;
      body: Buffer;
    }>((resolve, reject) => {
      const req = get(base + path, { headers, method }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      });
      req.on('error', reject);
    });
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'mje-public-assets-TEST-'));
    mkdirSync(join(root, 'assets'));
    mkdirSync(join(root, 'field'));
    writeFileSync(join(root, 'index.html'), '<html>TEST app</html>');
    writeFileSync(join(root, 'field/index.html'), '<html>TEST field</html>');
    writeFileSync(join(root, 'assets/main-Abcd1234.js'), javascript);
    writeFileSync(
      join(root, 'assets/style-Abcd1234.css'),
      'body{color:black}'.repeat(100),
    );
    writeFileSync(join(root, 'assets/plain.js'), javascript);
    const app = express();
    app.use((_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      next();
    });
    if (!process.env['A7_ASSET_BASELINE']) app.use(publicAssets(root));
    app.use(express.static(root, { dotfiles: 'deny', index: 'index.html' }));
    app.get('/api/auth-config', (_req, res) => res.json({ enabled: true }));
    app.get('/api/projects/home', (_req, res) =>
      res.status(401).json({ code: 'LOGIN_REQUIRED' }),
    );
    app.use((_req, res) => res.status(404).json({ code: 'NOT_FOUND' }));
    server = await new Promise<Server>((resolve) => {
      const running = app.listen(0, '127.0.0.1', () => resolve(running));
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('TEST listener unavailable');
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    if (root) rmSync(root, { recursive: true, force: true });
  });
  it('serves identical JS bytes through gzip with immutable cache and correct MIME', async () => {
    const result = await request('/assets/main-Abcd1234.js', {
      'Accept-Encoding': 'gzip',
    });
    expect(result.status).toBe(200);
    expect(result.headers['content-encoding']).toBe('gzip');
    expect(result.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(result.headers['content-type']).toContain('text/javascript');
    expect(result.headers['vary']).toContain('Accept-Encoding');
    expect(result.headers['x-content-type-options']).toBe('nosniff');
    expect(gunzipSync(result.body).toString()).toBe(javascript);
    expect(result.body.length).toBeLessThan(Buffer.byteLength(javascript));
  });
  it('supports CSS, identity negotiation and gzip;q=0', async () => {
    for (const encoding of ['identity', 'gzip;q=0, identity;q=1']) {
      const result = await request('/assets/style-Abcd1234.css', {
        'Accept-Encoding': encoding,
      });
      expect(result.headers['content-encoding']).toBeUndefined();
      expect(result.headers['content-type']).toContain('text/css');
      expect(result.body.toString()).toBe('body{color:black}'.repeat(100));
    }
  });
  it('separates validators for gzip and identity and supports conditional GET', async () => {
    const zipped = await request('/assets/main-Abcd1234.js', {
      'Accept-Encoding': 'gzip',
    });
    const raw = await request('/assets/main-Abcd1234.js', {
      'Accept-Encoding': 'identity',
    });
    expect(raw.headers['etag']).not.toBe(zipped.headers['etag']);
    const cached = await request('/assets/main-Abcd1234.js', {
      'Accept-Encoding': 'gzip',
      'If-None-Match': String(zipped.headers['etag']),
    });
    expect(cached.status).toBe(304);
    expect(cached.body.length).toBe(0);
    const otherVariant = await request('/assets/main-Abcd1234.js', {
      'Accept-Encoding': 'identity',
      'If-None-Match': String(zipped.headers['etag']),
    });
    expect(otherVariant.status).toBe(200);
  });
  it('HEAD has representation headers with no body', async () => {
    const result = await request(
      '/assets/main-Abcd1234.js',
      { 'Accept-Encoding': 'gzip' },
      'HEAD',
    );
    expect(result.status).toBe(200);
    expect(result.headers['content-encoding']).toBe('gzip');
    expect(Number(result.headers['content-length'])).toBeGreaterThan(0);
    expect(result.body.length).toBe(0);
  });
  it.each([
    '/',
    '/field/',
    '/assets/plain.js',
    '/api/auth-config',
    '/api/projects/home',
    '/assets/missing-Abcd1234.js',
    '/assets/../index.html',
    '/.env',
  ])('keeps %s uncached and uncompressed', async (path) => {
    const result = await request(path, { 'Accept-Encoding': 'gzip' });
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['content-encoding']).toBeUndefined();
    if (path === '/api/projects/home') expect(result.status).toBe(401);
    if (path === '/assets/missing-Abcd1234.js' || path === '/.env')
      expect(result.status).toBe(404);
  });
  it('does not cache a POST or unsupported encoding error', async () => {
    const post = await request('/assets/main-Abcd1234.js', {}, 'POST');
    expect(post.status).toBe(404);
    expect(post.headers['cache-control']).toBe('no-store');
    const rejected = await request('/assets/main-Abcd1234.js', {
      'Accept-Encoding': 'gzip;q=0, identity;q=0, *;q=0',
    });
    expect(rejected.status).toBe(406);
    expect(rejected.headers['cache-control']).toBe('no-store');
  });
});
