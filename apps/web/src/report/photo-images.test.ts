import { describe, expect, it } from 'vitest';
import { ImageCache } from './photo-images.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
function cache() {
  const fetched: string[] = [];
  const revoked: string[] = [];
  let made = 0;
  const pending: ((b: Blob) => void)[] = [];
  const c = new ImageCache(
    (id, which) => {
      fetched.push(`${which}:${id}`);
      return new Promise<Blob>((r) => pending.push(r));
    },
    () => `blob:test/${++made}`,
    (u) => revoked.push(u),
  );
  const answer = () => pending.shift()!(new Blob(['TEST']));
  return { c, fetched, revoked, answer };
}

describe('photo image cache', () => {
  it('shares one URL among users and revokes it after the last one', async () => {
    const t = cache();
    const a = t.c.acquire('p1', 'thumbnail');
    const b = t.c.acquire('p1', 'thumbnail');
    t.answer();
    expect(await a).toBe('blob:test/1');
    expect(await b).toBe('blob:test/1');
    expect(t.fetched).toEqual(['thumbnail:p1']);
    t.c.release('p1', 'thumbnail');
    await tick();
    expect(t.revoked).toEqual([]);
    t.c.release('p1', 'thumbnail');
    await tick();
    expect(t.revoked).toEqual(['blob:test/1']);
    // Thumbnail bytes are kept: a new URL, no second fetch.
    expect(await t.c.acquire('p1', 'thumbnail')).toBe('blob:test/2');
    expect(t.fetched).toEqual(['thumbnail:p1']);
  });

  it('a URL released before its bytes arrive is revoked once made', async () => {
    const t = cache();
    const url = t.c.acquire('p2', 'photo');
    t.c.release('p2', 'photo');
    t.answer();
    expect(await url).toBe('blob:test/1');
    await tick();
    expect(t.revoked).toEqual(['blob:test/1']);
  });

  it('a seeded thumbnail is not fetched; full photos are fetched each time', async () => {
    const t = cache();
    t.c.seed('p3', new Blob(['local']));
    expect(await t.c.acquire('p3', 'thumbnail')).toBe('blob:test/1');
    const full = t.c.acquire('p3', 'photo');
    t.answer();
    await full;
    t.c.release('p3', 'photo');
    const again = t.c.acquire('p3', 'photo');
    t.answer();
    await again;
    expect(t.fetched).toEqual(['photo:p3', 'photo:p3']);
  });

  it('dispose revokes everything still held', async () => {
    const t = cache();
    const a = t.c.acquire('p4', 'thumbnail');
    t.answer();
    await a;
    t.c.dispose();
    await tick();
    expect(t.revoked).toEqual(['blob:test/1']);
  });

  it('an image that cannot be had is null, not an error', async () => {
    const c = new ImageCache(
      () => Promise.reject(new Error('404')),
      () => 'x',
      () => undefined,
    );
    expect(await c.acquire('p5', 'thumbnail')).toBeNull();
  });
});
