/**
 * OD20: the bytes of a photo (or thumbnail) as a read-only account is served them, without the
 * location metadata a file can carry. Byte-level container surgery, never re-encoding.
 *
 * Reconstruct from validated structure, else fail closed:
 * - Nothing is kept because of its name or prefix alone. A structure is kept only when its
 *   length matches what its own fields declare (JPEG frame, table and scan headers; PNG chunks
 *   in their required order with their required sizes; the WebP bitstream chunks), so no
 *   payload can ride behind an accepted header. Small headers that carry only numbers (JFIF,
 *   Adobe, VP8X) are rebuilt from those numbers rather than copied. Anything that does not
 *   validate makes the whole copy null.
 * - Dropped: EXIF (a JPEG keeps only its Orientation, in a new one-tag EXIF block, so phone
 *   photos are not shown sideways), XMP, IPTC/Photoshop, MPF and anything after the end of the
 *   image (secondary images), comments, PNG text/eXIf/tIME and every free-form or unknown
 *   ancillary chunk, WebP EXIF/XMP. ICC profiles (JPEG APP2, PNG iCCP, WebP ICCP) are dropped
 *   too rather than sanitised: a wide-gamut photo may look slightly less saturated to a reader.
 * - Not served to a reader (null): HEIF/HEIC (its Exif and XMP are items located through iloc,
 *   possibly split into several extents, stored in idat or built from other items, so a byte
 *   edit that provably removes every copy is not feasible here; the reader gets the thumbnail),
 *   and animation (WebP ANIM/ANMF, whose frames may nest their own EXIF and XMP; APNG).
 * - Opaque compressed image data (JPEG entropy-coded segments, PNG IDAT, WebP VP8/VP8L/ALPH) is
 *   copied as it is: it is the picture, and it cannot be checked without decoding.
 * - Bounded and fail-closed: over PHOTO_MAX_BYTES, more than PARSE_STEPS segments, tables or
 *   chunks, truncation, a length running past its container, a missing end marker, or any
 *   other surprise yields null, never an exception; the caller then serves nothing (404).
 *
 * The input is never modified (the output is always a new array); the caller verifies the
 * stored bytes' sha256 before calling this.
 */
import { Budget, ascii, be16, be32, le32 } from './image-bytes.js';
import { PHOTO_MAX_BYTES, exifOrientation, sniffImage } from './photo-file.js';

/** The bytes without location metadata, or null when that cannot be done safely. */
export function withoutLocationMetadata(b: Uint8Array): Uint8Array | null {
  if (b.length > PHOTO_MAX_BYTES) return null;
  try {
    const budget = new Budget();
    switch (sniffImage(b)) {
      case 'jpeg':
        return jpeg(b, budget);
      case 'png':
        return png(b, budget);
      case 'webp':
        return webp(b, budget);
      default:
        // HEIF (see above) and anything unrecognised: not served to a reader.
        return null;
    }
  } catch {
    // Out of budget or any structure the code did not foresee: fail closed.
    return null;
  }
}

/** A new array holding the parts one after another (the parts are only read). */
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const bytes = (text: string) =>
  Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
const u16be = (v: number) => [(v >> 8) & 0xff, v & 0xff];

// ---------- JPEG ----------
/** A marker segment built from its payload. */
function jpegSegment(marker: number, payload: number[]): Uint8Array {
  const len = payload.length + 2;
  return Uint8Array.from([0xff, marker, ...u16be(len), ...payload]);
}
/** APP1 'Exif' with a big-endian TIFF whose IFD0 holds only Orientation (SHORT, 1 value). */
function orientationApp1(orientation: number): Uint8Array {
  return jpegSegment(0xe1, [
    ...bytes('Exif\0\0'),
    ...[0x4d, 0x4d, 0, 42, 0, 0, 0, 8], // 'MM', 42, IFD0 at 8
    ...[0, 1], // one entry
    ...[0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0],
    ...[0, 0, 0, 0], // no next IFD
  ]);
}
/**
 * JFIF APP0 rebuilt from its numbers (version, units, density) and without a thumbnail; null
 * (dropped) unless its length is exactly the header plus the thumbnail it declares.
 */
function jfifApp0(b: Uint8Array, p: number, n: number): Uint8Array | null {
  if (n < 14 || ascii(b, p, 5) !== 'JFIF\0') return null;
  if (n !== 14 + 3 * b[p + 12]! * b[p + 13]!) return null;
  const units = b[p + 7]!;
  const x = be16(b, p + 8);
  const y = be16(b, p + 10);
  if (units > 2 || !x || !y) return null;
  return jpegSegment(0xe0, [
    ...bytes('JFIF\0'),
    b[p + 5]!,
    b[p + 6]!,
    units,
    ...u16be(x),
    ...u16be(y),
    0,
    0,
  ]);
}
/** Adobe APP14 (colour transform) rebuilt from its numbers; null unless exactly 12 bytes. */
function adobeApp14(b: Uint8Array, p: number, n: number): Uint8Array | null {
  if (n !== 12 || ascii(b, p, 5) !== 'Adobe') return null;
  const transform = b[p + 11]!;
  if (transform > 2) return null;
  return jpegSegment(0xee, [
    ...bytes('Adobe'),
    ...u16be(be16(b, p + 5)),
    ...u16be(be16(b, p + 7)),
    ...u16be(be16(b, p + 9)),
    transform,
  ]);
}
/**
 * A frame, table or scan header whose payload [p, p + n) is exactly what its fields declare.
 * Any other marker (reserved, JPG extensions, unknown) is not followed.
 */
function jpegHeaderValid(
  b: Uint8Array,
  marker: number,
  p: number,
  n: number,
  budget: Budget,
): boolean {
  const end = p + n;
  // SOFn (not DHT C4, JPG C8, DAC CC) and DHP: P, Y, X, Nf, then 3 bytes per component.
  if (
    (marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)) ||
    marker === 0xde
  )
    return n >= 6 && n === 6 + 3 * b[p + 5]!;
  if (marker === 0xc4) {
    // DHT: tables of class/id, 16 counts and that many symbols.
    let q = p;
    while (q < end) {
      budget.step();
      if (q + 17 > end) return false;
      let count = 0;
      for (let i = 1; i <= 16; i++) count += b[q + i]!;
      q += 17 + count;
    }
    return n > 0 && q === end;
  }
  if (marker === 0xdb) {
    // DQT: tables of precision/id and 64 values of 1 or 2 bytes.
    let q = p;
    while (q < end) {
      budget.step();
      const precision = b[q]! >> 4;
      if (precision > 1) return false;
      q += 1 + (precision ? 128 : 64);
    }
    return n > 0 && q === end;
  }
  if (marker === 0xcc) return n > 0 && n % 2 === 0; // DAC
  if (marker === 0xda) return n >= 6 && n === 4 + 2 * b[p]!; // SOS: Ns, 2 per component, 3
  if (marker === 0xdc || marker === 0xdd) return n === 2; // DNL, DRI
  if (marker === 0xdf) return n === 1; // EXP
  return false;
}
function jpeg(b: Uint8Array, budget: Budget): Uint8Array | null {
  const orientation = exifOrientation(b);
  const out: Uint8Array[] = [b.subarray(0, 2)]; // SOI
  let orientationPlaced = false;
  let jfifPlaced = false;
  let o = 2;
  for (;;) {
    budget.step();
    if (o + 2 > b.length || b[o] !== 0xff) return null;
    const marker = b[o + 1]!;
    if (marker === 0xff) {
      o++; // fill byte
      continue;
    }
    if (marker === 0xd9) {
      // EOI: the image ends here. Anything after it (MPF secondary images with their own EXIF,
      // vendor trailers) is left out.
      out.push(b.subarray(o, o + 2));
      return concat(out);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(b.subarray(o, o + 2)); // TEM, RSTn: no length
      o += 2;
      continue;
    }
    if (marker === 0xd8) return null; // a second SOI: not a plain image
    if (o + 4 > b.length) return null;
    const len = be16(b, o + 2);
    const end = o + 2 + len;
    if (len < 2 || end > b.length) return null;
    const p = o + 4;
    const n = len - 2;
    if (marker >= 0xe0 && marker <= 0xef) {
      // Application segments are never copied; the few that matter are rebuilt.
      let rebuilt: Uint8Array | null = null;
      if (marker === 0xe0 && !jfifPlaced) {
        rebuilt = jfifApp0(b, p, n);
        jfifPlaced = rebuilt !== null;
      } else if (marker === 0xee) rebuilt = adobeApp14(b, p, n);
      else if (
        marker === 0xe1 &&
        !orientationPlaced &&
        ascii(b, p, 6) === 'Exif\0\0'
      ) {
        // Where the first EXIF block was: only its orientation survives.
        orientationPlaced = true;
        if (orientation !== null && orientation !== 1)
          rebuilt = orientationApp1(orientation);
      }
      if (rebuilt) out.push(rebuilt);
    } else if (marker !== 0xfe) {
      // Not a comment (dropped): a header that must validate, else nothing is served.
      if (!jpegHeaderValid(b, marker, p, n, budget)) return null;
      out.push(b.subarray(o, end));
    }
    o = end;
    if (marker !== 0xda) continue;
    // Entropy-coded data after a scan header runs to the next marker that is not a stuffed
    // byte (FF00) or a restart (FFD0–FFD7), either possibly preceded by fill bytes (FF...).
    // Linear in the file size, which is bounded above.
    const start = o;
    for (;;) {
      const ff = b.indexOf(0xff, o);
      if (ff < 0) return null; // no end marker: truncated
      let m = ff + 1;
      while (m < b.length && b[m] === 0xff) m++;
      if (m >= b.length) return null;
      const next = b[m]!;
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
        o = m + 1;
        continue;
      }
      o = ff;
      break;
    }
    out.push(b.subarray(start, o));
  }
}

// ---------- PNG ----------
/** Valid IHDR bit depths per colour type. */
const PNG_DEPTHS: Record<number, number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};
/** Fixed-size colour chunks that must come before PLTE and IDAT, at most once. */
const PNG_COLOUR: Record<string, number> = {
  gAMA: 4,
  cHRM: 32,
  sRGB: 1,
  cICP: 4,
  mDCV: 24,
  mDCv: 24,
  cLLI: 8,
  cLLi: 8,
};
/** Free-form, textual, private or unknown ancillary chunks: never copied. */
const PNG_DROPPED = new Set([
  'iCCP',
  'sPLT',
  'hIST',
  'tEXt',
  'zTXt',
  'iTXt',
  'eXIf',
  'tIME',
]);
const PNG_ANIMATION = new Set(['acTL', 'fcTL', 'fdAT']);
const CHUNK_TYPE = /^[A-Za-z]{4}$/;
/**
 * Only the critical chunks (IHDR first and valid, PLTE, consecutive IDAT, empty IEND last) and
 * fixed-size rendering chunks of exactly their size, in their required place, are kept. A
 * chunk out of order, of the wrong size, repeated, animated or critical and unknown makes the
 * copy null; any other ancillary chunk is dropped.
 */
function png(b: Uint8Array, budget: Budget): Uint8Array | null {
  const out: Uint8Array[] = [b.subarray(0, 8)];
  let o = 8;
  let colourType = -1;
  let depth = 0;
  let palette = 0; // entries; 0 = no PLTE
  let idat: 'before' | 'in' | 'after' = 'before';
  const seen = new Set<string>();
  for (;;) {
    budget.step();
    if (o + 12 > b.length) return null; // no IEND: truncated
    const n = be32(b, o);
    const type = ascii(b, o + 4, 4);
    const p = o + 8;
    const end = p + n + 4;
    if (!CHUNK_TYPE.test(type) || end > b.length) return null;
    const chunk = b.subarray(o, end);
    const first = o === 8;
    o = end;
    if (first !== (type === 'IHDR')) return null;
    if (type === 'IDAT') {
      if (idat === 'after' || (colourType === 3 && !palette)) return null;
      idat = 'in';
      out.push(chunk);
      continue;
    }
    if (idat === 'in') idat = 'after';
    if (PNG_ANIMATION.has(type)) return null;
    const once = () => {
      if (seen.has(type)) return false;
      seen.add(type);
      return true;
    };
    switch (type) {
      case 'IHDR': {
        if (n !== 13) return null;
        const w = be32(b, p);
        const h = be32(b, p + 4);
        depth = b[p + 8]!;
        colourType = b[p + 9]!;
        if (!w || !h || w > 0x7fffffff || h > 0x7fffffff) return null;
        if (!PNG_DEPTHS[colourType]?.includes(depth)) return null;
        if (b[p + 10] !== 0 || b[p + 11] !== 0 || b[p + 12]! > 1) return null;
        out.push(chunk);
        continue;
      }
      case 'IEND':
        if (n !== 0 || idat === 'before') return null;
        out.push(chunk);
        return concat(out); // anything after it is left out
      case 'PLTE':
        if (idat !== 'before' || !once()) return null;
        if (colourType === 0 || colourType === 4) return null;
        if (n === 0 || n % 3 || n > 768) return null;
        if (colourType === 3 && n / 3 > 2 ** depth) return null;
        palette = n / 3;
        out.push(chunk);
        continue;
      case 'tRNS': {
        if (idat !== 'before' || !once()) return null;
        const size =
          colourType === 0 ? n === 2 : colourType === 2 ? n === 6 : false;
        const ok =
          colourType === 3 ? palette > 0 && n >= 1 && n <= palette : size;
        if (!ok) return null;
        out.push(chunk);
        continue;
      }
      case 'bKGD': {
        if (idat !== 'before' || !once()) return null;
        const want =
          colourType === 3 ? 1 : colourType === 0 || colourType === 4 ? 2 : 6;
        if (n !== want || (colourType === 3 && !palette)) return null;
        out.push(chunk);
        continue;
      }
      case 'sBIT': {
        if (idat !== 'before' || palette || !once()) return null;
        const want = [1, 0, 3, 3, 2, 0, 4][colourType];
        if (n !== want) return null;
        out.push(chunk);
        continue;
      }
      case 'pHYs':
        if (idat !== 'before' || !once() || n !== 9 || b[p + 8]! > 1)
          return null;
        out.push(chunk);
        continue;
    }
    if (type in PNG_COLOUR) {
      if (idat !== 'before' || palette || !once()) return null;
      if (n !== PNG_COLOUR[type]) return null;
      out.push(chunk);
      continue;
    }
    // An unknown critical chunk (upper-case first letter) cannot be dropped safely.
    if (!PNG_DROPPED.has(type) && type[0]! >= 'A' && type[0]! <= 'Z')
      return null;
    // Any other ancillary chunk: dropped.
  }
}

// ---------- WebP ----------
const le32bytes = (v: number) => [
  v & 0xff,
  (v >>> 8) & 0xff,
  (v >>> 16) & 0xff,
  (v >>> 24) & 0xff,
];
/** VP8X flag bits (RIFF container spec). */
const VP8X_ALPHA = 0x10;
const VP8X_ANIMATION = 0x02;
/**
 * One still image: an optional VP8X (exactly 10 bytes, first; rebuilt with only its alpha flag
 * and canvas size), an optional ALPH before the bitstream, and exactly one VP8/VP8L bitstream.
 * EXIF, XMP, ICCP and unknown chunks are dropped; animation (flag, ANIM or ANMF) is null.
 */
function webp(b: Uint8Array, budget: Budget): Uint8Array | null {
  const size = le32(b, 4);
  const end = 8 + size;
  if (size < 4 || end > b.length) return null;
  const out: Uint8Array[] = [];
  let extended = false;
  let image = false;
  let o = 12;
  while (o < end) {
    budget.step();
    if (o + 8 > end) return null;
    const fourcc = ascii(b, o, 4);
    const len = le32(b, o + 4);
    const p = o + 8;
    const bodyEnd = p + len;
    if (bodyEnd > end) return null;
    const first = o === 12;
    // A missing final padding byte is tolerated; the output always carries it.
    o = Math.min(end, bodyEnd + (len % 2));
    if (fourcc === 'ANIM' || fourcc === 'ANMF') return null;
    if (fourcc === 'VP8X') {
      if (!first || len !== 10) return null;
      const flags = b[p]!;
      if (flags & VP8X_ANIMATION) return null;
      extended = true;
      out.push(
        Uint8Array.from([
          ...bytes('VP8X'),
          ...le32bytes(10),
          flags & VP8X_ALPHA,
          0,
          0,
          0,
          ...b.subarray(p + 4, p + 10), // canvas width-1 and height-1 (24 bits each)
        ]),
      );
      continue;
    }
    // The chunk as written (header and body, read only) and its padding byte, always zero.
    const whole = [b.subarray(p - 8, bodyEnd), new Uint8Array(len % 2)];
    if (fourcc === 'VP8 ' || fourcc === 'VP8L') {
      if (image || (!extended && !first)) return null;
      image = true;
      out.push(...whole);
      continue;
    }
    if (fourcc === 'ALPH') {
      if (!extended || image) return null;
      out.push(...whole);
      continue;
    }
    // EXIF, XMP, ICCP and anything unknown: dropped.
  }
  if (!image) return null;
  const chunks = concat(out);
  return concat([
    bytes('RIFF'),
    Uint8Array.from(le32bytes(chunks.length + 4)),
    bytes('WEBP'),
    chunks,
  ]);
}
