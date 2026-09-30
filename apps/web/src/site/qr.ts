/**
 * A minimal QR Code encoder (ISO/IEC 18004): byte mode, error correction level M, versions
 * 1–10 (up to 213 bytes, enough for the site entry link). It follows the reference algorithm
 * published by Project Nayuki (MIT): data and error-correction codewords per block, function
 * patterns, zig-zag placement, the 8 masks with the standard penalty score. No dependency, so
 * the entry code is never sent to a third-party renderer.
 */

/** Error-correction codewords per block and number of blocks, level M, versions 1–10. */
const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
export const MAX_VERSION = 10;

function rawModules(ver: number): number {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    r -= (25 * align - 10) * align - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
/** Data codewords of a version at level M. */
export function dataCapacity(ver: number): number {
  return (
    Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver - 1]! * BLOCKS[ver - 1]!
  );
}

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}
export function rsDivisor(degree: number): number[] {
  const r = new Array<number>(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j]!, root);
      if (j + 1 < r.length) r[j]! ^= r[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return r;
}
export function rsRemainder(data: number[], divisor: number[]): number[] {
  const r = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ r.shift()!;
    r.push(0);
    divisor.forEach((d, i) => (r[i]! ^= gfMul(d, factor)));
  }
  return r;
}

/** The data codewords: mode 0100, length, bytes, terminator and 0xEC/0x11 padding. */
function dataCodewords(bytes: Uint8Array, ver: number): number[] {
  const bits: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(4, 4);
  put(bytes.length, ver <= 9 ? 8 : 16);
  bytes.forEach((b) => put(b, 8));
  const cap = dataCapacity(ver) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8)
    out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return out;
}
/** Split into blocks, append each block's error correction, interleave. */
function interleave(data: number[], ver: number): number[] {
  const n = BLOCKS[ver - 1]!;
  const ecc = ECC_PER_BLOCK[ver - 1]!;
  const raw = Math.floor(rawModules(ver) / 8);
  const short = n - (raw % n);
  const shortLen = Math.floor(raw / n);
  const div = rsDivisor(ecc);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < n; i++) {
    const d = data.slice(k, k + shortLen - ecc + (i < short ? 0 : 1));
    k += d.length;
    const e = rsRemainder(d, div);
    if (i < short) d.push(0);
    blocks.push(d.concat(e));
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++)
    blocks.forEach((b, j) => {
      if (i !== shortLen - ecc || j >= short) out.push(b[i]!);
    });
  return out;
}

function alignment(ver: number, size: number): number[] {
  if (ver === 1) return [];
  const num = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (num * 2 - 2)) * 2;
  const r = [6];
  for (let pos = size - 7; r.length < num; pos -= step) r.splice(1, 0, pos);
  return r;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Format bits for level M (00) and a mask, BCH-coded and XOR-masked. */
export function formatBits(mask: number): number {
  const data = (0 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function penalty(m: boolean[][]): number {
  const size = m.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let i = 0; i < size; i++) {
    lines.push(m[i]!);
    lines.push(m.map((row) => row[i]!));
  }
  for (const line of lines) {
    // N1: runs of five or more of one colour.
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    // N3: finder-like 1:1:3:1:1 with four light modules on either side.
    const s = line.map((d) => (d ? '1' : '0')).join('');
    for (const p of ['10111010000', '00001011101'])
      for (let i = s.indexOf(p); i >= 0; i = s.indexOf(p, i + 1)) score += 40;
  }
  // N2: 2×2 blocks of one colour.
  for (let y = 0; y < size - 1; y++)
    for (let x = 0; x < size - 1; x++) {
      const c = m[y]![x];
      if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1])
        score += 3;
    }
  // N4: balance of dark modules.
  const dark = m.flat().filter(Boolean).length;
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** The module matrix (true = dark) of `text` as UTF-8, at the smallest version that fits. */
export function encodeQr(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let ver = 1;
  while (
    ver <= MAX_VERSION &&
    bytes.length + (ver <= 9 ? 2 : 3) > dataCapacity(ver)
  )
    ver++;
  if (ver > MAX_VERSION) throw new Error('QR_TOO_LONG');
  const size = ver * 4 + 17;
  const m: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const fn: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const set = (x: number, y: number, dark: boolean) => {
    m[y]![x] = dark;
    fn[y]![x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const)
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size)
          set(x, y, d !== 2 && d !== 4);
      }
  const pos = alignment(ver, size);
  pos.forEach((ax, i) =>
    pos.forEach((ay, j) => {
      const last = pos.length - 1;
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === last) ||
        (i === last && j === 0)
      )
        return;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );
  const drawFormat = (mask: number) => {
    const bits = formatBits(mask);
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
  const words = interleave(dataCodewords(bytes, ver), ver);
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const up = ((right + 1) & 2) === 0;
        const y = up ? size - 1 - v : v;
        if (!fn[y]![x] && i < words.length * 8) {
          m[y]![x] = ((words[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
  }
  const apply = (mask: number) => {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        if (!fn[y]![x] && MASKS[mask]!(x, y)) m[y]![x] = !m[y]![x];
  };
  let best = 0;
  let bestScore = Infinity;
  for (let k = 0; k < 8; k++) {
    apply(k);
    drawFormat(k);
    const s = penalty(m);
    if (s < bestScore) {
      best = k;
      bestScore = s;
    }
    apply(k);
  }
  apply(best);
  drawFormat(best);
  return m;
}

/** An SVG path of the dark modules, offset by a 4-module quiet zone. */
export function qrPath(m: boolean[][]): string {
  let d = '';
  m.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) d += `M${x + 4} ${y + 4}h1v1h-1z`;
    }),
  );
  return d;
}
