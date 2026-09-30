import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_VERSION,
  dataCapacity,
  encodeQr,
  formatBits,
  qrPath,
  rsDivisor,
  rsRemainder,
} from './qr.js';

const digest = (m: boolean[][]) =>
  createHash('sha256')
    .update(m.map((r) => r.map((d) => (d ? '1' : '0')).join('')).join('\n'))
    .digest('hex');

describe('QR encoder', () => {
  it('computes the standard error-correction codewords (1-M "HELLO WORLD" example)', () => {
    const data = [
      32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17,
    ];
    expect(rsRemainder(data, rsDivisor(10))).toEqual([
      196, 35, 39, 119, 235, 215, 231, 226, 93, 23,
    ]);
  });
  it('uses the standard level-M format bits', () => {
    expect(
      [0, 1, 2, 3, 4, 5, 6, 7].map((m) =>
        formatBits(m).toString(2).padStart(15, '0'),
      ),
    ).toEqual([
      '101010000010010',
      '101000100100101',
      '101111001111100',
      '101101101001011',
      '100010111111001',
      '100000011001110',
      '100111110010111',
      '100101010100000',
    ]);
  });
  it('has the level-M data capacities of versions 1–10', () => {
    expect(
      Array.from({ length: MAX_VERSION }, (_, i) => dataCapacity(i + 1)),
    ).toEqual([16, 28, 44, 64, 86, 108, 124, 154, 182, 216]);
  });
  it('picks the smallest version, draws finder patterns and refuses what does not fit', () => {
    expect(encodeQr('x'.repeat(14))).toHaveLength(21);
    expect(encodeQr('x'.repeat(15))).toHaveLength(25);
    expect(encodeQr('x'.repeat(213))).toHaveLength(57);
    expect(() => encodeQr('x'.repeat(214))).toThrow('QR_TOO_LONG');
    const m = encodeQr('https://example.test/field/#e=AbCdEfGhIjKlMnOpQrStU_');
    const size = m.length;
    for (const [x0, y0] of [
      [0, 0],
      [size - 7, 0],
      [0, size - 7],
    ] as const) {
      expect(m[y0]!.slice(x0, x0 + 7).every(Boolean)).toBe(true);
      expect(m[y0 + 1]![x0 + 1]).toBe(false);
      expect(m[y0 + 3]![x0 + 3]).toBe(true);
    }
    // dark module
    expect(m[size - 8]![8]).toBe(true);
    expect(qrPath([[true, false]])).toBe('M4 4h1v1h-1z');
  });
  it('is stable for links verified with an independent decoder', () => {
    // These matrices were decoded back to their text with macOS CoreImage (CIDetector) when
    // the encoder was written (versions 1–10, every capacity boundary); the digests pin them.
    const cases: [string, string][] = [
      [
        'hello world',
        '851bd1031e2539fc5e015f26d9096341dd6514602a440a5806dd968b7c1c2355',
      ],
      [
        'https://localhost:5198/field/#e=AbCdEfGhIjKlMnOpQrStUv',
        'a8df923fa94735c48656b5e9fac3583babd4416777cd8390e5875730d9b53eee',
      ],
      [
        `https://test-site-${'a'.repeat(60)}.example.test/field/#e=AbCdEfGhIjKlMnOpQrStUv`,
        'b5ea1b9ce08a27369e78a310e45013d41cf9f7d6c2b54c517b69b53d5fb388f1',
      ],
    ];
    for (const [text, hash] of cases)
      expect(digest(encodeQr(text)), text).toBe(hash);
  });
});
