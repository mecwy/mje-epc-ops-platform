/**
 * OD20: the bytes of a photo (or thumbnail) as a read-only account is served them, without the
 * location metadata a file can carry. Byte-level container surgery, never re-encoding: the
 * image data is copied unchanged and only metadata segments or chunks are left out.
 *
 * - Allowlist, not blocklist: a JPEG segment, PNG chunk or WebP chunk is kept only when it is
 *   needed to show the picture as written (frame, tables, scans, colour). EXIF, XMP, IPTC/
 *   Photoshop, MPF secondary images, comments, PNG text chunks, eXIf and unknown ancillary
 *   chunks are all dropped, as is anything after the end of the image.
 * - A JPEG keeps its EXIF Orientation in a new minimal EXIF block with that one tag, so a phone
 *   photo is not shown sideways; nothing else of the original EXIF is copied.
 * - HEIF/HEIC is not stripped: its Exif and XMP are items located through iloc, possibly split
 *   into several extents, stored in `idat` or built from other items, so a byte-level edit that
 *   provably removes every copy is not feasible here. A reader gets the (client-made, metadata-
 *   free) thumbnail instead; the original is not served to a reader (null).
 * - Bounded and fail-closed: over PHOTO_MAX_BYTES, more than PARSE_STEPS segments or chunks,
 *   truncation, a length running past its container, a missing end marker, an unknown critical
 *   structure, or any other surprise yields null, never an exception; the caller then does not
 *   serve the original to a reader.
 *
 * The stored bytes are never changed; the caller verifies their sha256 before calling this.
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

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------- JPEG ----------
/** APP1 'Exif' with a big-endian TIFF whose IFD0 holds only Orientation (SHORT, 1 value). */
function orientationApp1(orientation: number): Uint8Array {
  const body = [
    ...[0x45, 0x78, 0x69, 0x66, 0, 0], // 'Exif\0\0'
    ...[0x4d, 0x4d, 0, 42, 0, 0, 0, 8], // 'MM', 42, IFD0 at 8
    ...[0, 1], // one entry
    ...[0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0],
    ...[0, 0, 0, 0], // no next IFD
  ];
  const len = body.length + 2;
  return Uint8Array.from([0xff, 0xe1, len >> 8, len & 0xff, ...body]);
}
/**
 * Marker segments kept: frames (SOFn), Huffman/arithmetic tables, quantisation tables, restart
 * interval, scan headers, DNL, hierarchical markers. APPn and COM are decided by jpegAppKept.
 */
function jpegTableKept(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xcf) || // SOFn, DHT (C4), JPG (C8), DAC (CC)
    (marker >= 0xda && marker <= 0xdf) // SOS, DQT, DNL, DRI, DHP, EXP
  );
}
/** Application segments kept: JFIF (density), the ICC profile (colour) and Adobe (transform). */
function jpegAppKept(b: Uint8Array, o: number, marker: number): boolean {
  if (marker === 0xe0) return ascii(b, o + 4, 5) === 'JFIF\0';
  if (marker === 0xe2) return ascii(b, o + 4, 12) === 'ICC_PROFILE\0';
  if (marker === 0xee) return ascii(b, o + 4, 5) === 'Adobe';
  return false;
}
function jpeg(b: Uint8Array, budget: Budget): Uint8Array | null {
  const orientation = exifOrientation(b);
  const out: Uint8Array[] = [b.subarray(0, 2)]; // SOI
  let orientationPlaced = false;
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
    const isApp = marker >= 0xe0 && marker <= 0xef;
    if (isApp || marker === 0xfe) {
      if (jpegAppKept(b, o, marker)) out.push(b.subarray(o, end));
      else if (
        marker === 0xe1 &&
        !orientationPlaced &&
        ascii(b, o + 4, 6) === 'Exif\0\0'
      ) {
        // Where the first EXIF block was: only its orientation survives.
        orientationPlaced = true;
        if (orientation !== null && orientation !== 1)
          out.push(orientationApp1(orientation));
      }
    } else if (jpegTableKept(marker)) out.push(b.subarray(o, end));
    else return null; // reserved or extension markers: not followed
    o = end;
    if (marker !== 0xda) continue;
    // Entropy-coded data after a scan header runs to the next marker that is not a stuffed
    // byte (FF00) or a restart (FFD0–FFD7). Linear in the file size, which is bounded above.
    const start = o;
    for (;;) {
      const ff = b.indexOf(0xff, o);
      if (ff < 0 || ff + 1 >= b.length) return null; // no end marker: truncated
      const next = b[ff + 1]!;
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
        o = ff + 2;
        continue;
      }
      o = ff;
      break;
    }
    out.push(b.subarray(start, o));
  }
}

// ---------- PNG ----------
/**
 * Chunks kept: the critical ones and those that change how the pixels are shown (transparency,
 * colour space, gamma, significant bits, background, histogram, physical size, suggested
 * palettes, animation). Text (tEXt/zTXt/iTXt, which carry XMP and raw EXIF), eXIf, tIME and any
 * unknown or private ancillary chunk are dropped.
 */
const PNG_KEPT = new Set([
  'IHDR',
  'PLTE',
  'IDAT',
  'IEND',
  'tRNS',
  'cHRM',
  'gAMA',
  'iCCP',
  'sBIT',
  'sRGB',
  'cICP',
  'mDCV',
  'mDCv',
  'cLLI',
  'cLLi',
  'bKGD',
  'hIST',
  'pHYs',
  'sPLT',
  'acTL',
  'fcTL',
  'fdAT',
]);
const CHUNK_TYPE = /^[A-Za-z]{4}$/;
function png(b: Uint8Array, budget: Budget): Uint8Array | null {
  const out: Uint8Array[] = [b.subarray(0, 8)];
  let o = 8;
  for (;;) {
    budget.step();
    if (o + 12 > b.length) return null; // no IEND: truncated
    const len = be32(b, o);
    const type = ascii(b, o + 4, 4);
    const end = o + 12 + len;
    if (!CHUNK_TYPE.test(type) || end > b.length) return null;
    if (o === 8 && type !== 'IHDR') return null;
    if (PNG_KEPT.has(type)) out.push(b.subarray(o, end));
    // An unknown critical chunk (upper-case first letter) cannot be dropped safely.
    else if (type[0]! >= 'A' && type[0]! <= 'Z') return null;
    if (type === 'IEND') return concat(out); // anything after it is left out
    o = end;
  }
}

// ---------- WebP ----------
/** Chunks kept: the bitstreams, extended header, alpha, animation and the ICC profile. */
const WEBP_KEPT = new Set([
  'VP8 ',
  'VP8L',
  'VP8X',
  'ALPH',
  'ANIM',
  'ANMF',
  'ICCP',
]);
const WEBP_IMAGE = new Set(['VP8 ', 'VP8L', 'ANMF']);
/** VP8X flag bits for EXIF and XMP metadata (RIFF container spec). */
const VP8X_METADATA = 0x08 | 0x04;
function webp(b: Uint8Array, budget: Budget): Uint8Array | null {
  const size = le32(b, 4);
  const end = 8 + size;
  if (size < 4 || end > b.length) return null;
  const out: Uint8Array[] = [];
  let image = false;
  let o = 12;
  while (o < end) {
    budget.step();
    if (o + 8 > end) return null;
    const fourcc = ascii(b, o, 4);
    const len = le32(b, o + 4);
    const bodyEnd = o + 8 + len;
    if (bodyEnd > end) return null;
    if (WEBP_KEPT.has(fourcc)) {
      const chunk = b.slice(o, bodyEnd);
      if (fourcc === 'VP8X') {
        if (o !== 12 || len < 10) return null;
        chunk[8] = chunk[8]! & ~VP8X_METADATA;
      }
      out.push(chunk);
      if (len % 2) out.push(new Uint8Array(1)); // padding, also if the file left it out
      if (WEBP_IMAGE.has(fourcc)) image = true;
    }
    // A missing final padding byte is tolerated; the output always carries it.
    o = Math.min(end, bodyEnd + (len % 2));
  }
  if (!image) return null;
  const body = concat(out);
  const head = new Uint8Array(12);
  head.set(b.subarray(0, 4), 0); // 'RIFF'
  const riff = body.length + 4;
  head[4] = riff & 0xff;
  head[5] = (riff >>> 8) & 0xff;
  head[6] = (riff >>> 16) & 0xff;
  head[7] = (riff >>> 24) & 0xff;
  head.set(b.subarray(8, 12), 8); // 'WEBP'
  return concat([head, body]);
}
