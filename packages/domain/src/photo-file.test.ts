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
  mediaTypeMatches,
  readFileClaims,
  sniffImage,
  THUMB_MEDIA_TYPES,
} from './photo-file.js';
import { photoAsOf, photographedItems } from './photo-store.js';
import type { PhotoDto } from '@mje/contracts';

// Synthetic TEST metadata: a made-up position and time, not a real site.
const EXIF: TestExif = {
  dateTimeOriginal: '2026:10:05 09:15:30',
  offsetTimeOriginal: '+02:00',
  gps: {
    latRef: 'N',
    lat: [
      [44, 1],
      [30, 1],
      [1800, 100],
    ],
    lonRef: 'W',
    lon: [
      [20, 1],
      [15, 1],
      [0, 1],
    ],
  },
};
const CLAIMS = {
  takenLocal: '2026-10-05T09:15:30',
  takenAt: '2026-10-05T07:15:30.000Z',
  gps: { lat: '44.505000', lon: '-20.250000' },
};

describe('photo files: magic bytes', () => {
  it('recognises the four accepted families from their bytes, not their names', () => {
    expect(sniffImage(testJpeg())).toBe('jpeg');
    expect(sniffImage(testPng())).toBe('png');
    expect(sniffImage(testWebp())).toBe('webp');
    expect(sniffImage(testHeif())).toBe('heif');
    expect(sniffImage(testHeif({ brand: 'avif' }))).toBeNull();
    expect(sniffImage(Buffer.from('GIF89a TEST'))).toBeNull();
    expect(
      sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });
  it('the declared type must be accepted and agree with the bytes', () => {
    expect(mediaTypeMatches('image/jpeg', testJpeg())).toBe(true);
    expect(mediaTypeMatches('image/heic', testHeif())).toBe(true);
    expect(mediaTypeMatches('image/heif', testHeif())).toBe(true);
    expect(mediaTypeMatches('image/png', testJpeg())).toBe(false);
    expect(mediaTypeMatches('image/jpeg', Buffer.from('%PDF-1.7'))).toBe(false);
    expect(mediaTypeMatches('image/gif', Buffer.from('GIF89a'))).toBe(false);
    expect(mediaTypeMatches('text/html', testJpeg())).toBe(false);
    // Thumbnails: no HEIF.
    expect(mediaTypeMatches('image/heic', testHeif(), THUMB_MEDIA_TYPES)).toBe(
      false,
    );
    expect(mediaTypeMatches('image/webp', testWebp(), THUMB_MEDIA_TYPES)).toBe(
      true,
    );
  });
});

describe('photo files: EXIF claims', () => {
  it('reads time, offset and GPS from every container, both byte orders', () => {
    for (const littleEndian of [false, true]) {
      const tiff = exifTiff({ ...EXIF, littleEndian });
      for (const file of [
        testJpeg({ exif: tiff }),
        testPng({ exif: tiff }),
        testWebp({ exif: tiff }),
        testHeif({ exif: tiff }),
      ])
        expect(readFileClaims(file)).toEqual(CLAIMS);
    }
  });
  it('keeps the written time without a zone when the file has no offset (no server timezone)', () => {
    const claims = readFileClaims(
      testJpeg({ exif: exifTiff({ dateTimeOriginal: '2026:10:05 23:59:59' }) }),
    );
    expect(claims).toEqual({
      takenLocal: '2026-10-05T23:59:59',
      takenAt: null,
      gps: null,
    });
  });
  it('a file without metadata, or with unusable values, yields no claim', () => {
    const none = { takenLocal: null, takenAt: null, gps: null };
    expect(readFileClaims(testJpeg())).toEqual(none);
    expect(readFileClaims(testPng({ tag: 'x' }))).toEqual(none);
    expect(readFileClaims(testHeif())).toEqual(none);
    for (const bad of [
      { dateTimeOriginal: '2026:02:30 10:00:00' },
      { dateTimeOriginal: '2026:10:05 24:00:00' },
      { dateTimeOriginal: '    :  :     :  :  ' },
      { gps: { ...EXIF.gps!, latRef: 'X' } },
      {
        gps: {
          ...EXIF.gps!,
          lat: [
            [95, 1],
            [0, 1],
            [0, 1],
          ] as NonNullable<TestExif['gps']>['lat'],
        },
      },
      {
        gps: {
          ...EXIF.gps!,
          lon: [
            [20, 0],
            [0, 1],
            [0, 1],
          ] as NonNullable<TestExif['gps']>['lon'],
        },
      },
    ] as TestExif[])
      expect(
        readFileClaims(testJpeg({ exif: exifTiff(bad) })),
        JSON.stringify(bad),
      ).toEqual(none);
    // An offset that is not an offset leaves only the written time.
    expect(
      readFileClaims(
        testJpeg({
          exif: exifTiff({
            dateTimeOriginal: '2026:10:05 09:15:30',
            offsetTimeOriginal: 'CEST',
          }),
        }),
      ).takenAt,
    ).toBeNull();
  });
  it('never throws on truncated or hostile structures', () => {
    const tiff = exifTiff(EXIF);
    const files = [
      testJpeg({ exif: tiff }),
      testPng({ exif: tiff }),
      testWebp({ exif: tiff }),
      testHeif({ exif: tiff }),
    ];
    for (const f of files)
      for (let n = 0; n < f.length; n += 7)
        expect(() => readFileClaims(f.subarray(0, n))).not.toThrow();
    // Offsets pointing far outside the block.
    const hostile = Buffer.from(tiff);
    hostile.writeUInt32BE(0xfffffff0, 4);
    expect(readFileClaims(testJpeg({ exif: hostile }))).toEqual({
      takenLocal: null,
      takenAt: null,
      gps: null,
    });
    // Random bytes behind valid magic numbers.
    for (let i = 0; i < 200; i++) {
      const noise = Buffer.alloc(64 + (i % 50));
      for (let j = 0; j < noise.length; j++)
        noise[j] = (i * 31 + j * 17) & 0xff;
      for (const head of [
        Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
        Buffer.from('RIFF\x40\x00\x00\x00WEBP', 'latin1'),
        Buffer.from('\x00\x00\x00\x18ftypheic', 'latin1'),
      ])
        expect(() =>
          readFileClaims(Buffer.concat([head, noise])),
        ).not.toThrow();
    }
  });
});

describe('photos in a report day', () => {
  const photo = (over: Partial<PhotoDto>): PhotoDto => ({
    id: 'p',
    projectId: 'x',
    businessDate: '2026-10-05',
    source: 'camera',
    mediaType: 'image/jpeg',
    sizeBytes: 1,
    sha256: 'a'.repeat(64),
    capture: {
      lat: '44.800000',
      lon: '20.400000',
      accuracyM: '12.00',
      fixAt: '2026-10-05T08:00:00.000Z',
    },
    deviceCapturedAt: null,
    file: { takenLocal: null, takenAt: null, gps: null },
    location: 'device',
    hasThumbnail: false,
    receivedAt: '2026-10-05T08:00:01.000Z',
    uploadedByPersonId: 'u',
    link: null,
    linkVersion: 0,
    ...over,
  });
  it('only work items with a current item link count as photographed', () => {
    expect(
      photographedItems([
        photo({ link: { type: 'item', id: 'support' } }),
        photo({ link: { type: 'issue', id: 'rail' } }),
        photo({ link: null }),
      ]),
    ).toEqual(new Set(['support']));
  });
  it('a snapshot entry keeps the link and the position kind, not the coordinates', () => {
    const frozen = photoAsOf(photo({ link: { type: 'item', id: 'support' } }));
    expect(frozen).toEqual({
      id: 'p',
      source: 'camera',
      location: 'device',
      accuracyM: '12.00',
      deviceCapturedAt: null,
      fileTakenAt: null,
      fileTakenLocal: null,
      link: { type: 'item', id: 'support' },
    });
    expect(JSON.stringify(frozen)).not.toContain('44.8');
  });
});
