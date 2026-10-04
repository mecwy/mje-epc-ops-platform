import type { RequestHandler } from 'express';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const HASHED_TEXT = /^[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.(js|css)$/;
const etag = (body: Buffer) =>
  `"${createHash('sha256').update(body).digest('hex')}"`;

/** Only immutable, public build output; never HTML, runtime config or API data. */
export function publicAssets(webRoot: string): RequestHandler {
  const assets = new Map<
    string,
    {
      body: Buffer;
      gzip: Buffer;
      identityTag: string;
      gzipTag: string;
      type: string;
    }
  >();
  const directory = join(webRoot, 'assets');
  let files: Dirent[];
  try {
    files = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    files = [];
  }
  for (const file of files) {
    if (!file.isFile() || !HASHED_TEXT.test(file.name)) continue;
    const body = readFileSync(join(directory, file.name));
    const gzip = gzipSync(body);
    assets.set(`/assets/${file.name}`, {
      body,
      gzip,
      identityTag: etag(body),
      gzipTag: etag(gzip),
      type: file.name.endsWith('.js')
        ? 'text/javascript; charset=utf-8'
        : 'text/css; charset=utf-8',
    });
  }
  return (request, response, next) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return next();
    const asset = assets.get(request.path);
    if (!asset) return next();
    response.vary('Accept-Encoding');
    const encoding = request.acceptsEncodings('gzip', 'identity');
    if (!encoding) {
      response.status(406).end();
      return;
    }
    const compressed = encoding === 'gzip';
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    response.setHeader('Content-Type', asset.type);
    response.setHeader('ETag', compressed ? asset.gzipTag : asset.identityTag);
    if (compressed) response.setHeader('Content-Encoding', 'gzip');
    // Express supplies Content-Length, conditional GET/304 and HEAD behavior.
    response.send(compressed ? asset.gzip : asset.body);
  };
}
