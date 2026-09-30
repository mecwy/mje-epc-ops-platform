import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  exifTiff,
  testHeif,
  testJpeg,
  testPng,
  testWebp,
  type TestExif,
} from '@mje/testing';
import {
  PARSE_STEPS,
  PHOTO_MAX_BYTES,
  exifOrientation,
  readFileClaims,
  sniffImage,
} from './photo-file.js';
import { withoutLocationMetadata } from './photo-strip.js';

// Synthetic TEST metadata only: a fake position at 0.0000 / 0.0000 and a made-up time.
const ZERO: [[number, number], [number, number], [number, number]] = [
  [0, 1],
  [0, 1],
  [0, 1],
];
const FAKE_GPS: TestExif = {
  dateTimeOriginal: '2026:10:05 09:15:30',
  gps: { latRef: 'N', lat: ZERO, lonRef: 'E', lon: ZERO },
};
const GPS_CLAIM = { lat: '0.000000', lon: '0.000000' };
const XMP = Buffer.from(
  'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><exif:GPSLatitude>0,0.0N</exif:GPSLatitude><exif:GPSLongitude>0,0.0E</exif:GPSLongitude></x:xmpmeta>',
  'latin1',
);
const has = (b: Uint8Array, text: string) =>
  Buffer.from(b).includes(Buffer.from(text, 'latin1'));
/** The fake-GPS EXIF block and a marker text: neither may survive anywhere in a copy. */
const GPS_TIFF = exifTiff(FAKE_GPS);
const MARK = 'TEST-GPS-0.0000,0.0000';
const HIDDEN = Buffer.concat([
  Buffer.from('Exif\0\0', 'latin1'),
  GPS_TIFF,
  Buffer.from(MARK, 'latin1'),
]);
function expectNoPayload(out: Uint8Array | null) {
  if (!out) return;
  const b = Buffer.from(out);
  expect(b.includes(GPS_TIFF), 'fake GPS EXIF bytes').toBe(false);
  for (const text of [MARK, 'GPSLatitude', 'Exif\0\0MM'])
    expect(has(b, text), text).toBe(false);
}
/** Strips and checks that the input (Buffer or Uint8Array) is left exactly as it was. */
function strip(input: Uint8Array): Uint8Array | null {
  const before = Buffer.from(input);
  const out = withoutLocationMetadata(input);
  expect(Buffer.from(input).equals(before), 'input unchanged').toBe(true);
  return out;
}

const segment = (marker: number, body: Buffer) => {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
};
const app1Exif = (e: TestExif) =>
  segment(
    0xe1,
    Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exifTiff(e)]),
  );
/** The TEST JPEG with extra segments right after SOI and optional bytes after EOI. */
function jpegWith(segments: Buffer[], trailer = Buffer.alloc(0)): Buffer {
  const base = testJpeg();
  return Buffer.concat([
    base.subarray(0, 2),
    ...segments,
    base.subarray(2),
    trailer,
  ]);
}
/** Frame, tables, scan and EOI of the TEST JPEG: what every stripped copy must keep as is. */
const imageData = (b: Uint8Array) => {
  const buf = Buffer.from(b);
  return buf.subarray(buf.indexOf(Buffer.from([0xff, 0xc0])));
};

const pngChunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
/** The TEST PNG with `chunks` inserted after IHDR. */
function pngWith(chunks: Buffer[], trailer = Buffer.alloc(0)): Buffer {
  const base = testPng();
  const afterIhdr = 8 + 12 + 13;
  return Buffer.concat([
    base.subarray(0, afterIhdr),
    ...chunks,
    base.subarray(afterIhdr),
    trailer,
  ]);
}
const pngTypes = (b: Uint8Array) => {
  const out: string[] = [];
  const buf = Buffer.from(b);
  for (let o = 8; o + 8 <= buf.length; o += 12 + buf.readUInt32BE(o))
    out.push(buf.toString('latin1', o + 4, o + 8));
  return out;
};

const riffChunk = (fourcc: string, data: Buffer) => {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, Buffer.alloc(data.length % 2)]);
};
const riff = (chunks: Buffer[]) => {
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};
/** VP8X with the ICC (0x20), EXIF (0x08) and XMP (0x04) flags set; canvas 1x1. */
const vp8x = (flags = 0x20 | 0x08 | 0x04) =>
  riffChunk('VP8X', Buffer.from([flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
const VP8L = riffChunk(
  'VP8L',
  Buffer.from('2f00000010071011118888fe07', 'hex'),
);
const webpTypes = (b: Uint8Array) => {
  const out: string[] = [];
  const buf = Buffer.from(b);
  for (let o = 12; o + 8 <= buf.length;) {
    const len = buf.readUInt32LE(o + 4);
    out.push(buf.toString('latin1', o, o + 4));
    o += 8 + len + (len % 2);
  }
  return out;
};

describe('reader copies without location metadata (OD20)', () => {
  it('JPEG: the EXIF block with a GPS position and XMP are removed; the image data is copied unchanged', () => {
    const input = jpegWith([
      app1Exif(FAKE_GPS),
      segment(0xe1, XMP),
      segment(0xfe, Buffer.from('TEST comment', 'latin1')),
    ]);
    expect(readFileClaims(input).gps).toEqual(GPS_CLAIM);
    const out = strip(input)!;
    expect(out).not.toBeNull();
    expect(sniffImage(out)).toBe('jpeg');
    expect(readFileClaims(out)).toEqual({
      takenLocal: null,
      takenAt: null,
      gps: null,
    });
    for (const text of ['Exif', 'GPSLatitude', 'xmpmeta', 'TEST comment'])
      expect(has(out, text)).toBe(false);
    expect(Buffer.from(imageData(out))).toEqual(imageData(input));
    // Little-endian EXIF is removed the same way.
    const le = jpegWith([app1Exif({ ...FAKE_GPS, littleEndian: true })]);
    expect(readFileClaims(le).gps).toEqual(GPS_CLAIM);
    expect(readFileClaims(strip(le)!).gps).toBeNull();
  });

  it('JPEG: only the orientation survives, in a new EXIF block with that one tag', () => {
    const input = jpegWith([app1Exif({ ...FAKE_GPS, orientation: 6 })]);
    expect(exifOrientation(input)).toBe(6);
    const out = strip(input)!;
    expect(exifOrientation(out)).toBe(6);
    expect(readFileClaims(out)).toEqual({
      takenLocal: null,
      takenAt: null,
      gps: null,
    });
    // SOI, APP1 of 34 bytes (Exif header + 26-byte TIFF), then the image data unchanged.
    expect(out.length).toBe(2 + 36 + imageData(input).length);
    // Upright already (1): no EXIF block at all.
    const upright = strip(
      jpegWith([app1Exif({ ...FAKE_GPS, orientation: 1 })]),
    )!;
    expect(has(upright, 'Exif')).toBe(false);
    expect(Buffer.from(upright)).toEqual(
      Buffer.concat([testJpeg().subarray(0, 2), imageData(input)]),
    );
  });

  it('JPEG: rebuilds JFIF and Adobe, drops the ICC profile and every other APP segment and anything after the image (MPF secondary images)', () => {
    const jfif = segment(
      0xe0,
      Buffer.from('4a46494600010100000100010000', 'hex'),
    );
    const icc = segment(
      0xe2,
      Buffer.from('ICC_PROFILE\0\x01\x01TEST', 'latin1'),
    );
    const adobe = segment(
      0xee,
      Buffer.from('Adobe\0\x64\0\0\0\0\x01', 'latin1'),
    );
    const mpf = segment(0xe2, Buffer.from('MPF\0TEST', 'latin1'));
    const iptc = segment(0xed, Buffer.from('Photoshop 3.0\0TEST', 'latin1'));
    // A secondary image after EOI carrying its own GPS, as multi-picture files do.
    const secondary = jpegWith([app1Exif(FAKE_GPS)]);
    const input = jpegWith([jfif, icc, adobe, mpf, iptc], secondary);
    const out = strip(input)!;
    expect(Buffer.from(out)).toEqual(
      Buffer.concat([
        testJpeg().subarray(0, 2),
        jfif,
        adobe,
        imageData(testJpeg()),
      ]),
    );
    expect(has(out, 'Exif')).toBe(false);
    expect(has(out, 'ICC_PROFILE')).toBe(false);
  });

  it('JPEG: a GPS payload behind an accepted JFIF, ICC_PROFILE or Adobe prefix never survives', () => {
    const jfif14 = Buffer.from('4a46494600010201002c012c0000', 'hex');
    const adobe12 = Buffer.from('Adobe\0\x64\0\0\0\0\x01', 'latin1');
    const cases = [
      segment(0xe0, Buffer.concat([jfif14, HIDDEN])),
      segment(
        0xe2,
        Buffer.concat([Buffer.from('ICC_PROFILE\0\x01\x01', 'latin1'), HIDDEN]),
      ),
      segment(0xee, Buffer.concat([adobe12, HIDDEN])),
    ];
    for (const seg of cases) {
      const out = strip(jpegWith([seg]));
      expect(out).not.toBeNull();
      expectNoPayload(out);
    }
    // A JFIF block is rebuilt from its numbers: version, units and density kept, no thumbnail.
    const withThumb = segment(
      0xe0,
      Buffer.concat([
        Buffer.from('4a46494600010201002c012c0101', 'hex'),
        Buffer.from([1, 2, 3]),
      ]),
    );
    expect(Buffer.from(strip(jpegWith([withThumb]))!)).toEqual(
      Buffer.concat([
        testJpeg().subarray(0, 2),
        segment(0xe0, jfif14),
        imageData(testJpeg()),
      ]),
    );
    // Adobe of any other length, or a JFIF whose thumbnail does not match its length: dropped.
    for (const seg of [
      segment(0xee, Buffer.concat([adobe12, Buffer.from([0])])),
      segment(0xe0, Buffer.from('4a46494600010201002c012c0101', 'hex')),
    ])
      expect(Buffer.from(strip(jpegWith([seg]))!)).toEqual(testJpeg());
  });

  it('JPEG: table and scan headers are copied only when their length matches their structure', () => {
    const base = testJpeg();
    const dqt = base.indexOf(Buffer.from([0xff, 0xdb]));
    const len = base.readUInt16BE(dqt + 2);
    // The first DQT with the payload appended inside its declared length.
    const grown = Buffer.concat([
      base.subarray(0, dqt + 2),
      Buffer.from([(len + HIDDEN.length) >> 8, (len + HIDDEN.length) & 0xff]),
      base.subarray(dqt + 4, dqt + 2 + len),
      HIDDEN,
      base.subarray(dqt + 2 + len),
    ]);
    expect(strip(grown)).toBeNull();
    // A restart interval of the wrong length.
    expect(strip(jpegWith([segment(0xdd, Buffer.from([0, 4, 0]))]))).toBeNull();
    expect(
      Buffer.from(strip(jpegWith([segment(0xdd, Buffer.from([0, 4]))]))!),
    ).toEqual(jpegWith([segment(0xdd, Buffer.from([0, 4]))]));
  });

  it('JPEG: fill bytes before a restart marker stay inside the scan', () => {
    const base = testJpeg();
    const eoi = base.length - 2;
    const image = Buffer.concat([
      base.subarray(0, eoi),
      Buffer.from([
        0x12, 0xff, 0xff, 0xd0, 0x34, 0x56, 0xff, 0xff, 0xff, 0xd1, 0x78,
      ]),
      base.subarray(eoi),
    ]);
    const input = Buffer.concat([
      image.subarray(0, 2),
      app1Exif(FAKE_GPS),
      image.subarray(2),
    ]);
    expect(Buffer.from(strip(input)!)).toEqual(image);
  });

  it('JPEG: follows stuffed bytes, restart markers and a second scan (progressive) to the real end', () => {
    const base = testJpeg();
    const eoi = base.length - 2;
    // Scan data with a stuffed FF00 and a restart marker, then tables and a second scan.
    const scan = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]);
    const secondScan = Buffer.concat([
      segment(0xc4, Buffer.alloc(17)), // one empty table: class/id + 16 counts
      segment(0xda, Buffer.from('010100003f00', 'hex')),
      Buffer.from([0x78, 0xff, 0x00, 0x9a]),
    ]);
    const image = Buffer.concat([
      base.subarray(0, eoi),
      scan,
      secondScan,
      base.subarray(eoi),
    ]);
    const input = Buffer.concat([
      image.subarray(0, 2),
      app1Exif(FAKE_GPS),
      image.subarray(2),
      Buffer.from('TEST trailer with GPS 0.0 0.0', 'latin1'),
    ]);
    expect(Buffer.from(strip(input)!)).toEqual(image);
  });

  it('PNG: eXIf and every text chunk (tEXt, zTXt, iTXt with XMP) are removed; pixels and colour chunks stay', () => {
    const gama = pngChunk('gAMA', Buffer.from([0, 0, 0xb1, 0x8f]));
    const input = pngWith(
      [
        gama,
        pngChunk('eXIf', exifTiff(FAKE_GPS)),
        pngChunk('tEXt', Buffer.from('Comment\0TEST', 'latin1')),
        pngChunk(
          'zTXt',
          Buffer.from('Raw profile type exif\0\0TEST', 'latin1'),
        ),
        pngChunk(
          'iTXt',
          Buffer.concat([
            Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'latin1'),
            XMP,
          ]),
        ),
        pngChunk('tIME', Buffer.from([7, 234, 10, 5, 9, 15, 30])),
        pngChunk('prVt', Buffer.from('TEST private', 'latin1')),
      ],
      Buffer.from('TEST trailing bytes'),
    );
    expect(readFileClaims(input).gps).toEqual(GPS_CLAIM);
    const out = strip(input)!;
    expect(pngTypes(out)).toEqual(['IHDR', 'gAMA', 'IDAT', 'IEND']);
    expect(readFileClaims(out).gps).toBeNull();
    expect(Buffer.from(out)).toEqual(
      Buffer.concat([testPng().subarray(0, 33), gama, testPng().subarray(33)]),
    );
    // Nothing to remove: the same bytes.
    expect(Buffer.from(strip(testPng())!)).toEqual(testPng());
  });

  it('PNG: an unknown critical chunk or a missing IHDR is not followed (null)', () => {
    expect(strip(pngWith([pngChunk('ABCD', Buffer.alloc(1))]))).toBeNull();
    const noIhdr = Buffer.concat([
      testPng().subarray(0, 8),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
    expect(strip(noIhdr)).toBeNull();
  });

  it('PNG: a retained chunk that breaks its structure fails closed, whatever it carries', () => {
    const base = testPng();
    const iend = base.length - 12;
    // IEND with a payload (and a valid CRC).
    const fatEnd = Buffer.concat([
      base.subarray(0, iend),
      pngChunk('IEND', HIDDEN),
    ]);
    expect(strip(fatEnd)).toBeNull();
    // IHDR of the wrong length, or with an invalid bit depth.
    const ihdr = base.subarray(16, 29);
    const withIhdr = (data: Buffer) =>
      Buffer.concat([
        base.subarray(0, 8),
        pngChunk('IHDR', data),
        base.subarray(33),
      ]);
    expect(strip(withIhdr(Buffer.concat([ihdr, HIDDEN])))).toBeNull();
    const badDepth = Buffer.from(ihdr);
    badDepth[8] = 7;
    expect(strip(withIhdr(badDepth))).toBeNull();
    expect(Buffer.from(strip(withIhdr(Buffer.from(ihdr)))!)).toEqual(base);
    // A fixed-size chunk carrying more than its size.
    expect(
      strip(
        pngWith([
          pngChunk(
            'gAMA',
            Buffer.concat([Buffer.from([0, 0, 0xb1, 0x8f]), HIDDEN]),
          ),
        ]),
      ),
    ).toBeNull();
    // Split image data, a palette after the image data, a chunk after IEND's place.
    const idat = base.subarray(33, iend);
    const gama = pngChunk('gAMA', Buffer.from([0, 0, 0xb1, 0x8f]));
    const png = (...parts: Buffer[]) =>
      Buffer.concat([base.subarray(0, 33), ...parts, base.subarray(iend)]);
    expect(strip(png(idat, gama, idat))).toBeNull();
    expect(strip(png(idat, pngChunk('PLTE', Buffer.alloc(3))))).toBeNull();
    expect(strip(png(idat, gama))).toBeNull();
    expect(strip(png(pngChunk('PLTE', Buffer.alloc(4)), idat))).toBeNull();
    // Animated PNG is not served to a reader.
    expect(
      strip(png(pngChunk('acTL', Buffer.from([0, 0, 0, 1, 0, 0, 0, 0])), idat)),
    ).toBeNull();
    // No image data at all.
    expect(strip(png())).toBeNull();
  });

  it('WebP: the EXIF, XMP and ICC chunks are removed, VP8X rebuilt and the RIFF size fixed', () => {
    const icc = riffChunk('ICCP', Buffer.from('TEST icc', 'latin1'));
    const input = riff([
      vp8x(),
      icc,
      VP8L,
      riffChunk('EXIF', exifTiff(FAKE_GPS)),
      riffChunk('XMP ', XMP),
      riffChunk('TEST', Buffer.from('odd', 'latin1')),
    ]);
    expect(readFileClaims(input).gps).toEqual(GPS_CLAIM);
    const out = Buffer.from(strip(input)!);
    expect(webpTypes(out)).toEqual(['VP8X', 'VP8L']);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect(out[20]).toBe(0); // ICC, EXIF and XMP flags cleared
    expectNoPayload(out);
    expect(has(out, 'TEST icc')).toBe(false);
    expect(readFileClaims(out).gps).toBeNull();
    expect(out.toString('latin1', 8, 12)).toBe('WEBP');
    // The simple format with an EXIF chunk appended (as testWebp makes it): removed too.
    const simple = testWebp({ exif: exifTiff(FAKE_GPS) });
    expect(readFileClaims(simple).gps).toEqual(GPS_CLAIM);
    const plain = Buffer.from(strip(simple)!);
    expect(webpTypes(plain)).toEqual(['VP8L']);
    expect(plain).toEqual(testWebp());
  });

  it('WebP: a file without an image chunk, or VP8X not first, is not followed (null)', () => {
    expect(strip(riff([vp8x()]))).toBeNull();
    expect(strip(riff([VP8L, vp8x()]))).toBeNull();
    // VP8X of another size.
    expect(
      strip(
        riff([
          riffChunk('VP8X', Buffer.concat([Buffer.alloc(10), HIDDEN])),
          VP8L,
        ]),
      ),
    ).toBeNull();
  });

  it('WebP: animation is not served to a reader: frames may nest their own EXIF and XMP', () => {
    const frame = riffChunk(
      'ANMF',
      Buffer.concat([
        Buffer.alloc(16), // frame header
        VP8L,
        riffChunk('EXIF', GPS_TIFF),
        riffChunk('XMP ', Buffer.concat([XMP, Buffer.from(MARK, 'latin1')])),
      ]),
    );
    const anim = riffChunk('ANIM', Buffer.alloc(6));
    expect(readFileClaims(riff([vp8x(0x02), anim, frame])).gps).toBeNull(); // hidden from the reader
    expect(strip(riff([vp8x(0x02), anim, frame]))).toBeNull();
    expect(strip(riff([vp8x(0), anim, frame]))).toBeNull();
    expect(strip(riff([vp8x(0x02), VP8L]))).toBeNull();
    expect(strip(riff([vp8x(0), VP8L, frame]))).toBeNull();
  });

  it('never changes its input, Buffer or Uint8Array, accepted or rejected', () => {
    const accepted = riff([vp8x(), VP8L, riffChunk('EXIF', GPS_TIFF)]);
    const rejected = riff([
      vp8x(0x02 | 0x08),
      VP8L,
      riffChunk('EXIF', GPS_TIFF),
    ]);
    for (const file of [accepted, rejected, jpegWith([app1Exif(FAKE_GPS)])]) {
      strip(file);
      strip(new Uint8Array(file));
    }
    expect(Buffer.from(accepted)[20]).toBe(0x20 | 0x08 | 0x04);
  });

  it('HEIF/HEIC is never served to a reader as the original (null): its Exif item is not edited in place', () => {
    const heif = testHeif({ exif: exifTiff(FAKE_GPS) });
    expect(readFileClaims(heif).gps).toEqual(GPS_CLAIM);
    expect(strip(heif)).toBeNull();
    expect(strip(testHeif())).toBeNull();
    expect(strip(Buffer.from('GIF89a TEST'))).toBeNull();
    expect(strip(new Uint8Array())).toBeNull();
  });

  it('truncated files: every prefix yields null or a copy without the position, never an exception', () => {
    const files = [
      jpegWith([app1Exif(FAKE_GPS), segment(0xe1, XMP)]),
      pngWith([pngChunk('eXIf', exifTiff(FAKE_GPS))]),
      riff([vp8x(), VP8L, riffChunk('EXIF', exifTiff(FAKE_GPS))]),
    ];
    for (const file of files)
      for (let n = 0; n < file.length; n++) {
        const out = strip(file.subarray(0, n));
        // A cut file has no end marker (JPEG EOI, PNG IEND) or a RIFF size past its end.
        expect(out, `${sniffImage(file)} cut at ${n}`).toBeNull();
      }
  });

  it('malformed lengths and noise never throw; lengths past the end are not followed', () => {
    // A JPEG segment length running past the end of the file.
    const long = jpegWith([Buffer.from([0xff, 0xe1, 0xff, 0xff, 0x45])]);
    expect(strip(long)).toBeNull();
    // A segment length below 2.
    expect(strip(jpegWith([Buffer.from([0xff, 0xfe, 0, 1])]))).toBeNull();
    // A reserved marker.
    expect(strip(jpegWith([Buffer.from([0xff, 0x02, 0, 2])]))).toBeNull();
    // A PNG chunk length past the end, and a RIFF size past the end.
    const png = testPng();
    const badPng = Buffer.from(png);
    badPng.writeUInt32BE(0xfffffff0, 33);
    expect(strip(badPng)).toBeNull();
    const badRiff = Buffer.from(testWebp());
    badRiff.writeUInt32LE(badRiff.length, 4);
    expect(strip(badRiff)).toBeNull();
    // Deterministic noise behind each family's magic bytes.
    let seed = 7;
    const noise = Buffer.alloc(4096).map(() => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed & 0xff;
    });
    for (const head of [
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('RIFF\x00\x10\x00\x00WEBP', 'latin1'),
    ])
      for (let cut = 0; cut <= noise.length; cut += 97)
        expect(() =>
          strip(Buffer.concat([head, noise.subarray(0, cut)])),
        ).not.toThrow();
  });

  it('is bounded: over the photo size limit, or more segments or chunks than the step budget, yields null', () => {
    const big = Buffer.alloc(PHOTO_MAX_BYTES + 1);
    testJpeg().copy(big);
    expect(strip(big)).toBeNull();
    const comments = Array.from({ length: PARSE_STEPS + 1 }, () =>
      Buffer.from([0xff, 0xfe, 0, 2]),
    );
    expect(strip(jpegWith(comments))).toBeNull();
    const chunks = Array.from({ length: PARSE_STEPS + 1 }, () =>
      pngChunk('prVt', Buffer.alloc(0)),
    );
    expect(strip(pngWith(chunks))).toBeNull();
    // Well under the budget is fine.
    expect(strip(jpegWith(comments.slice(0, 100)))).not.toBeNull();
  });
});
