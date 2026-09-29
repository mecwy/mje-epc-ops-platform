/**
 * What the server reads from an uploaded photo file itself (U2.1 rule 8). Pure and bounded:
 * no I/O, no image decoding, no face or content analysis. Everything returned here is a claim
 * written by whatever produced the file; it never verifies where or when a photo was taken.
 *
 * - `sniffImage`: the container family from the magic bytes (the declared type is not trusted).
 * - `readFileClaims`: EXIF DateTimeOriginal (+ OffsetTimeOriginal) and the GPS position, from
 *   JPEG (APP1), PNG (eXIf), WebP (EXIF chunk) and HEIF (Exif item via iinf/iloc). A minimal
 *   reader instead of a library: four tags are needed, every offset is bounds-checked, values
 *   are kept as written (no Date revival in the server's timezone) and any malformed structure
 *   simply yields no claim.
 */
import { isRealDate, isRealTimestamp } from '@mje/contracts';

export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const THUMB_MAX_BYTES = 300 * 1024;
export const PHOTO_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;
export type PhotoMediaType = (typeof PHOTO_MEDIA_TYPES)[number];
/** Thumbnails are made by the client for display only; HEIF is not accepted for them. */
export const THUMB_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export type ImageFamily = 'jpeg' | 'png' | 'webp' | 'heif';

const FAMILY: Record<PhotoMediaType, ImageFamily> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heif',
  'image/heif': 'heif',
};
/** HEIF image brands (ISO/IEC 23008-12). AVIF ('avif', 'avis') is deliberately not accepted. */
const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
]);

const ascii = (b: Uint8Array, at: number, n: number) =>
  at < 0 || at + n > b.length
    ? ''
    : String.fromCharCode(...b.subarray(at, at + n));
const be16 = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const be32 = (b: Uint8Array, o: number) =>
  ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
const le32 = (b: Uint8Array, o: number) =>
  ((b[o + 3]! << 24) >>> 0) + (b[o + 2]! << 16) + (b[o + 1]! << 8) + b[o]!;

/** Container family from the leading bytes; null for anything else. */
export function sniffImage(b: Uint8Array): ImageFamily | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return 'jpeg';
  if (
    b.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)
  )
    return 'png';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP')
    return 'webp';
  if (
    b.length >= 12 &&
    ascii(b, 4, 4) === 'ftyp' &&
    HEIF_BRANDS.has(ascii(b, 8, 4))
  )
    return 'heif';
  return null;
}
/** The declared type is one we accept and the bytes are really of that family. */
export function mediaTypeMatches(
  declared: string,
  bytes: Uint8Array,
  accepted: readonly string[] = PHOTO_MEDIA_TYPES,
): declared is PhotoMediaType {
  if (!accepted.includes(declared)) return false;
  return FAMILY[declared as PhotoMediaType] === sniffImage(bytes);
}

export interface FileClaims {
  /** DateTimeOriginal as written ('YYYY-MM-DDTHH:MM:SS', no zone), or null. */
  takenLocal: string | null;
  /** The same instant as ISO-8601 UTC, only when the file also records its offset. */
  takenAt: string | null;
  /** GPS position written in the file, 6 decimals, or null. */
  gps: { lat: string; lon: string } | null;
}
const NONE: FileClaims = { takenLocal: null, takenAt: null, gps: null };

// ---------- locating the TIFF block ----------
interface Span {
  start: number;
  end: number;
}
function jpegTiff(b: Uint8Array): Span | null {
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null;
    const marker = b[o + 1]!;
    if (marker === 0xff) {
      o++;
      continue;
    }
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      o += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null;
    const len = be16(b, o + 2);
    if (len < 2 || o + 2 + len > b.length) return null;
    if (marker === 0xe1 && ascii(b, o + 4, 6) === 'Exif\0\0')
      return { start: o + 10, end: o + 2 + len };
    o += 2 + len;
  }
  return null;
}
function pngTiff(b: Uint8Array): Span | null {
  let o = 8;
  while (o + 12 <= b.length) {
    const len = be32(b, o);
    const type = ascii(b, o + 4, 4);
    if (o + 12 + len > b.length) return null;
    if (type === 'eXIf') return { start: o + 8, end: o + 8 + len };
    if (type === 'IEND') return null;
    o += 12 + len;
  }
  return null;
}
function webpTiff(b: Uint8Array): Span | null {
  const end = Math.min(b.length, 8 + le32(b, 4));
  let o = 12;
  while (o + 8 <= end) {
    const len = le32(b, o + 4);
    if (o + 8 + len > end) return null;
    if (ascii(b, o, 4) === 'EXIF') {
      const start = ascii(b, o + 8, 6) === 'Exif\0\0' ? o + 14 : o + 8;
      return { start, end: o + 8 + len };
    }
    o += 8 + len + (len % 2);
  }
  return null;
}
interface Box {
  type: string;
  body: number;
  end: number;
}
function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let o = from;
  while (o + 8 <= to && out.length < 256) {
    let size = be32(b, o);
    let header = 8;
    if (size === 1) {
      if (o + 16 > to || be32(b, o + 8) !== 0) return out;
      size = be32(b, o + 12);
      header = 16;
    } else if (size === 0) size = to - o;
    if (size < header || o + size > to) return out;
    out.push({ type: ascii(b, o + 4, 4), body: o + header, end: o + size });
    o += size;
  }
  return out;
}
function uint(b: Uint8Array, o: number, size: number): number | null {
  if (size === 0) return 0;
  if (o + size > b.length) return null;
  if (size === 2) return be16(b, o);
  if (size === 4) return be32(b, o);
  if (size === 8) return be32(b, o) === 0 ? be32(b, o + 4) : null;
  return null;
}
function heifTiff(b: Uint8Array): Span | null {
  const meta = boxes(b, 0, b.length).find((x) => x.type === 'meta');
  if (!meta) return null;
  const inner = boxes(b, meta.body + 4, meta.end);
  const iinf = inner.find((x) => x.type === 'iinf');
  const iloc = inner.find((x) => x.type === 'iloc');
  if (!iinf || !iloc) return null;
  // iinf: full box; entry count u16 (v0) or u32; then infe boxes.
  const iinfVersion = b[iinf.body]!;
  const entriesAt = iinf.body + 4 + (iinfVersion === 0 ? 2 : 4);
  let exifId: number | null = null;
  for (const infe of boxes(b, entriesAt, iinf.end)) {
    if (infe.type !== 'infe') continue;
    const v = b[infe.body]!;
    if (v < 2) continue;
    const idSize = v === 2 ? 2 : 4;
    const id = uint(b, infe.body + 4, idSize);
    if (id !== null && ascii(b, infe.body + 4 + idSize + 2, 4) === 'Exif') {
      exifId = id;
      break;
    }
  }
  if (exifId === null) return null;
  // iloc: full box.
  const v = b[iloc.body]!;
  if (v > 2) return null;
  let o = iloc.body + 4;
  if (o + 4 > iloc.end) return null;
  const offsetSize = b[o]! >> 4;
  const lengthSize = b[o]! & 15;
  const baseSize = b[o + 1]! >> 4;
  const indexSize = v === 0 ? 0 : b[o + 1]! & 15;
  o += 2;
  const idSize = v < 2 ? 2 : 4;
  const count = uint(b, o, v < 2 ? 2 : 4);
  if (count === null) return null;
  o += v < 2 ? 2 : 4;
  for (let i = 0; i < count && o < iloc.end; i++) {
    const id = uint(b, o, idSize);
    o += idSize;
    let method = 0;
    if (v >= 1) {
      method = (uint(b, o, 2) ?? 0) & 15;
      o += 2;
    }
    o += 2; // data_reference_index
    const base = uint(b, o, baseSize);
    o += baseSize;
    const extents = uint(b, o, 2);
    o += 2;
    if (id === null || base === null || extents === null) return null;
    let first: { offset: number; length: number } | null = null;
    for (let e = 0; e < extents; e++) {
      o += indexSize;
      const offset = uint(b, o, offsetSize);
      o += offsetSize;
      const length = uint(b, o, lengthSize);
      o += lengthSize;
      if (offset === null || length === null) return null;
      first ??= { offset: base + offset, length };
    }
    if (id !== exifId) continue;
    if (method !== 0 || !first || first.offset + 4 > b.length) return null;
    const end = Math.min(b.length, first.offset + first.length);
    const start = first.offset + 4 + be32(b, first.offset);
    return start < end ? { start, end } : null;
  }
  return null;
}

// ---------- TIFF ----------
interface Tag {
  type: number;
  count: number;
  /** Absolute offset of the value bytes. */
  at: number;
}
const TYPE_SIZE: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  7: 1,
  9: 4,
  10: 8,
};
function tiff(b: Uint8Array, span: Span) {
  const { start, end } = span;
  if (end - start < 8) return null;
  const order = ascii(b, start, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  const u16 = (o: number) => (le ? b[o]! | (b[o + 1]! << 8) : be16(b, o));
  const u32 = (o: number) => (le ? le32(b, o) : be32(b, o));
  if (u16(start + 2) !== 42) return null;
  const ifd = (rel: number): Map<number, Tag> => {
    const tags = new Map<number, Tag>();
    const at = start + rel;
    if (rel < 8 || at + 2 > end) return tags;
    const n = u16(at);
    if (n > 512 || at + 2 + n * 12 > end) return tags;
    for (let i = 0; i < n; i++) {
      const e = at + 2 + i * 12;
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = (TYPE_SIZE[type] ?? 0) * count;
      if (!size || size > 4096) continue;
      const valueAt = size <= 4 ? e + 8 : start + u32(e + 8);
      if (valueAt < start || valueAt + size > end) continue;
      tags.set(u16(e), { type, count, at: valueAt });
    }
    return tags;
  };
  const text = (t: Tag | undefined) => {
    if (!t || t.type !== 2) return null;
    let s = '';
    for (let i = 0; i < t.count; i++) {
      const c = b[t.at + i]!;
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const long = (t: Tag | undefined) =>
    t && t.type === 4 && t.count === 1 ? u32(t.at) : null;
  const rationals = (t: Tag | undefined): [bigint, bigint][] | null =>
    t && t.type === 5 && t.count === 3
      ? [0, 1, 2].map((i) => [
          BigInt(u32(t.at + i * 8)),
          BigInt(u32(t.at + i * 8 + 4)),
        ])
      : null;
  const ifd0 = ifd(u32(start + 4));
  const exifAt = long(ifd0.get(0x8769));
  const gpsAt = long(ifd0.get(0x8825));
  const exif = exifAt === null ? new Map<number, Tag>() : ifd(exifAt);
  const gps = gpsAt === null ? new Map<number, Tag>() : ifd(gpsAt);
  return {
    dateTimeOriginal: text(exif.get(0x9003)),
    offsetTimeOriginal: text(exif.get(0x9011)),
    latRef: text(gps.get(1)),
    lat: rationals(gps.get(2)),
    lonRef: text(gps.get(3)),
    lon: rationals(gps.get(4)),
  };
}

/** Degrees/minutes/seconds rationals → signed decimal degrees with 6 decimals, exactly. */
function degrees(
  dms: [bigint, bigint][] | null,
  ref: string | null,
  positive: string,
  negative: string,
  limit: bigint,
): string | null {
  if (!dms || (ref !== positive && ref !== negative)) return null;
  if (dms.some(([, d]) => d === 0n)) return null;
  const [[dn, dd], [mn, md], [sn, sd]] = dms as [
    [bigint, bigint],
    [bigint, bigint],
    [bigint, bigint],
  ];
  // value = dn/dd + mn/(60 md) + sn/(3600 sd), scaled by 1e6 and rounded half up.
  const den = dd * md * sd * 3600n;
  const num = dn * md * sd * 3600n + mn * dd * sd * 60n + sn * dd * md;
  const micro = (num * 1_000_000n * 2n + den) / (den * 2n);
  if (micro > limit * 1_000_000n) return null;
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, '0');
  const sign = ref === negative && micro !== 0n ? '-' : '';
  return `${sign}${whole}.${frac}`;
}
const EXIF_DATE = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const OFFSET = /^[+-]\d{2}:\d{2}$/;

/** EXIF claims of the file; a file without (readable) metadata yields all nulls. */
export function readFileClaims(b: Uint8Array): FileClaims {
  const family = sniffImage(b);
  const span =
    family === 'jpeg'
      ? jpegTiff(b)
      : family === 'png'
        ? pngTiff(b)
        : family === 'webp'
          ? webpTiff(b)
          : family === 'heif'
            ? heifTiff(b)
            : null;
  if (!span) return NONE;
  const t = tiff(b, span);
  if (!t) return NONE;
  let takenLocal: string | null = null;
  let takenAt: string | null = null;
  const m = t.dateTimeOriginal ? EXIF_DATE.exec(t.dateTimeOriginal) : null;
  if (m) {
    const local = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
    if (isRealDate(local.slice(0, 10)) && isRealTimestamp(`${local}Z`)) {
      takenLocal = local;
      const offset = t.offsetTimeOriginal?.trim() ?? '';
      if (OFFSET.test(offset) && isRealTimestamp(`${local}${offset}`))
        takenAt = new Date(`${local}${offset}`).toISOString();
    }
  }
  const lat = degrees(t.lat, t.latRef, 'N', 'S', 90n);
  const lon = degrees(t.lon, t.lonRef, 'E', 'W', 180n);
  return { takenLocal, takenAt, gps: lat && lon ? { lat, lon } : null };
}
