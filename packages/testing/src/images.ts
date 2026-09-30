/**
 * Synthetic TEST images, generated in code. No real photo, person or place is ever used:
 * the pixels are a fixed 8x8 gradient and every metadata value is supplied by the test.
 * The JPEG and PNG decode as images; the HEIF container only carries the boxes a metadata
 * reader needs and is not a decodable picture.
 */
import { crc32, deflateSync } from 'node:zlib';

/** 8x8 gradient JPEG (baseline, no APP segments), produced once from `testPng` and embedded. */
const JPEG_8X8 = Buffer.from(
  '/9j/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwAGBgYGBgYKBgYKDgoKCg4SDg4ODhIXEhISEhIXHBcXFxcXFxwcHBwcHBwcIiIiIiIiJycnJycsLCwsLCwsLCws/9sAQwEHBwcLCgsTCgoTLh8aHy4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4u/90ABAAB/9oADAMBAAIRAxEAPwDE0TwT935P0rqv+EJ/2P0rqNE/hrqq48VmuI9o/eLyDOsV9Tj7x//Z',
  'base64',
);

export type Rational = [number, number];
export interface TestExif {
  /** 'YYYY:MM:DD HH:MM:SS' exactly as a camera writes it. */
  dateTimeOriginal?: string;
  /** '+HH:MM' / '-HH:MM'. */
  offsetTimeOriginal?: string;
  gps?: {
    latRef: string;
    lat: [Rational, Rational, Rational];
    lonRef: string;
    lon: [Rational, Rational, Rational];
  };
  /** IFD0 Orientation (1–8), as a SHORT. */
  orientation?: number;
  littleEndian?: boolean;
}

/** A TIFF/EXIF block (IFD0 → Exif IFD + GPS IFD) with only the requested tags. */
export function exifTiff(e: TestExif): Buffer {
  const le = e.littleEndian ?? false;
  type Entry = {
    tag: number;
    type: 2 | 3 | 4 | 5;
    count: number;
    data: Buffer;
  };
  const ascii = (s: string) => Buffer.from(`${s}\0`, 'latin1');
  const rationals = (rs: Rational[]) => {
    const b = Buffer.alloc(rs.length * 8);
    rs.forEach(([n, d], i) => {
      if (le) {
        b.writeUInt32LE(n, i * 8);
        b.writeUInt32LE(d, i * 8 + 4);
      } else {
        b.writeUInt32BE(n, i * 8);
        b.writeUInt32BE(d, i * 8 + 4);
      }
    });
    return b;
  };
  const u16 = (b: Buffer, v: number, o: number) =>
    le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o);
  const u32 = (b: Buffer, v: number, o: number) =>
    le ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o);
  const exif: Entry[] = [];
  if (e.dateTimeOriginal !== undefined) {
    const data = ascii(e.dateTimeOriginal);
    exif.push({ tag: 0x9003, type: 2, count: data.length, data });
  }
  if (e.offsetTimeOriginal !== undefined) {
    const data = ascii(e.offsetTimeOriginal);
    exif.push({ tag: 0x9011, type: 2, count: data.length, data });
  }
  const gps: Entry[] = [];
  if (e.gps) {
    gps.push(
      { tag: 1, type: 2, count: 2, data: ascii(e.gps.latRef) },
      { tag: 2, type: 5, count: 3, data: rationals(e.gps.lat) },
      { tag: 3, type: 2, count: 2, data: ascii(e.gps.lonRef) },
      { tag: 4, type: 5, count: 3, data: rationals(e.gps.lon) },
    );
  }
  // Layout: header(8) | IFD0 | Exif IFD | GPS IFD | out-of-line values.
  const ifdSize = (n: number) => 2 + n * 12 + 4;
  const ifd0: Entry[] = [];
  const ifd0At = 8;
  const ifd0Count =
    (e.orientation !== undefined ? 1 : 0) +
    (exif.length ? 1 : 0) +
    (gps.length ? 1 : 0);
  const exifAt = ifd0At + ifdSize(ifd0Count);
  const gpsAt = exifAt + (exif.length ? ifdSize(exif.length) : 0);
  let dataAt = gpsAt + (gps.length ? ifdSize(gps.length) : 0);
  const pointer = (tag: number, at: number) => {
    const d = Buffer.alloc(4);
    u32(d, at, 0);
    ifd0.push({ tag, type: 4, count: 1, data: d });
  };
  if (e.orientation !== undefined) {
    const d = Buffer.alloc(2);
    u16(d, e.orientation, 0);
    ifd0.push({ tag: 0x0112, type: 3, count: 1, data: d });
  }
  if (exif.length) pointer(0x8769, exifAt);
  if (gps.length) pointer(0x8825, gpsAt);
  const tail: Buffer[] = [];
  const writeIfd = (entries: Entry[]) => {
    const b = Buffer.alloc(ifdSize(entries.length));
    u16(b, entries.length, 0);
    entries.forEach((en, i) => {
      const o = 2 + i * 12;
      u16(b, en.tag, o);
      u16(b, en.type, o + 2);
      u32(b, en.count, o + 4);
      if (en.data.length <= 4) en.data.copy(b, o + 8);
      else {
        u32(b, dataAt, o + 8);
        tail.push(en.data);
        dataAt += en.data.length;
      }
    });
    return b;
  };
  const header = Buffer.alloc(8);
  header.write(le ? 'II' : 'MM', 0, 'latin1');
  u16(header, 42, 2);
  u32(header, ifd0At, 4);
  const parts = [header, writeIfd(ifd0)];
  if (exif.length) parts.push(writeIfd(exif));
  if (gps.length) parts.push(writeIfd(gps));
  return Buffer.concat([...parts, ...tail]);
}

const segment = (marker: number, body: Buffer) => {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
};
/** The TEST JPEG, optionally with an EXIF block and a comment that makes its bytes unique. */
export function testJpeg(o: { exif?: Buffer; tag?: string } = {}): Buffer {
  const parts = [JPEG_8X8.subarray(0, 2)];
  if (o.exif)
    parts.push(
      segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), o.exif])),
    );
  if (o.tag !== undefined)
    parts.push(segment(0xfe, Buffer.from(`TEST ${o.tag}`, 'latin1')));
  parts.push(JPEG_8X8.subarray(2));
  return Buffer.concat(parts);
}

const pngChunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
/** 8x8 RGB gradient PNG; `tag` goes into a tEXt chunk, `exif` into an eXIf chunk. */
export function testPng(
  o: { exif?: Buffer; tag?: string; size?: number } = {},
): Buffer {
  const size = o.size ?? 8;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = 1 + size * 3;
  const raw = Buffer.alloc(size * row);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      raw[y * row + 1 + x * 3] = (x * 30) & 0xff;
      raw[y * row + 2 + x * 3] = (y * 30) & 0xff;
      raw[y * row + 3 + x * 3] = 128;
    }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...(o.tag !== undefined
      ? [pngChunk('tEXt', Buffer.from(`Comment\0TEST ${o.tag}`, 'latin1'))]
      : []),
    ...(o.exif ? [pngChunk('eXIf', o.exif)] : []),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const riffChunk = (fourcc: string, data: Buffer) => {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([
    head,
    data,
    data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0),
  ]);
};
/** 1x1 lossless WebP; optional EXIF chunk. */
export function testWebp(o: { exif?: Buffer; tag?: string } = {}): Buffer {
  const vp8l = Buffer.from('2f00000010071011118888fe07', 'hex');
  const body = Buffer.concat([
    Buffer.from('WEBP', 'latin1'),
    riffChunk('VP8L', vp8l),
    ...(o.exif ? [riffChunk('EXIF', o.exif)] : []),
    ...(o.tag !== undefined
      ? [riffChunk('TEST', Buffer.from(o.tag, 'latin1'))]
      : []),
  ]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

const box = (type: string, ...payload: Buffer[]) => {
  const data = Buffer.concat(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, data]);
};
const fullBox = (type: string, version: number, ...payload: Buffer[]) =>
  box(type, Buffer.from([version, 0, 0, 0]), ...payload);
/**
 * HEIF container (major brand `brand`) whose only item is an EXIF block, located through
 * iinf/iloc exactly as a camera file does. Not a decodable image.
 */
export function testHeif(
  o: { exif?: Buffer; brand?: string; tag?: string } = {},
): Buffer {
  const ftyp = box(
    'ftyp',
    Buffer.from(o.brand ?? 'heic', 'latin1'),
    Buffer.alloc(4),
    Buffer.from('mif1heic', 'latin1'),
  );
  const tag =
    o.tag !== undefined
      ? box('free', Buffer.from(o.tag, 'latin1'))
      : Buffer.alloc(0);
  if (!o.exif) return Buffer.concat([ftyp, tag, box('mdat')]);
  const payload = Buffer.concat([
    Buffer.from([0, 0, 0, 6]),
    Buffer.from('Exif\0\0', 'latin1'),
    o.exif,
  ]);
  const infe = fullBox(
    'infe',
    2,
    Buffer.from([0, 1, 0, 0]),
    Buffer.from('Exif', 'latin1'),
    Buffer.from([0]),
  );
  const iinf = fullBox('iinf', 0, Buffer.from([0, 1]), infe);
  // iloc v0: offset_size 4, length_size 4, base_offset_size 0; one item, one extent.
  const ilocFor = (offset: number) => {
    const b = Buffer.alloc(2 + 2 + 2 + 2 + 2 + 4 + 4);
    b[0] = 0x44;
    b[1] = 0x00;
    b.writeUInt16BE(1, 2);
    b.writeUInt16BE(1, 4);
    b.writeUInt16BE(0, 6);
    b.writeUInt16BE(1, 8);
    b.writeUInt32BE(offset, 10);
    b.writeUInt32BE(payload.length, 14);
    return fullBox('iloc', 0, b);
  };
  const meta = (offset: number) =>
    fullBox('meta', 0, box('hdlr', Buffer.alloc(24)), iinf, ilocFor(offset));
  const before = ftyp.length + tag.length + meta(0).length + 8;
  return Buffer.concat([ftyp, tag, meta(before), box('mdat', payload)]);
}
