/**
 * Photo boundary DTOs (U2.1 rule 8). A photo supports one moment and one view of the site; it is
 * a claim, never a verification. It belongs to one project and site business day and backs one
 * work item or one issue. In-app capture ("camera") must carry the device fix the client took
 * when the picture was made; an album upload never carries the uploader's position, only what
 * the file itself says (read on the server). Numbers are decimal strings, never floats.
 */
import { isRealTimestamp } from './report.js';
import {
  InvalidReportInput,
  itemKey,
  date,
  id,
  obj,
  oneOf,
  str,
  version,
} from './parse.js';

export const PHOTO_SOURCES = ['camera', 'album'] as const;
export type PhotoSourceDto = (typeof PHOTO_SOURCES)[number];
export type PhotoLinkDto = { type: 'item' | 'issue'; id: string };
/** Where a photo's position comes from; 'none' is shown as "no capture position". */
export type PhotoLocationKind = 'device' | 'file' | 'none';

/** The device fix sent with an in-app capture, as decimal strings. */
export interface CaptureFixDto {
  lat: string;
  lon: string;
  accuracyM: string;
  fixAt: string;
}
/** A capture fix as received: parts may be missing; the store decides whether it is usable. */
export interface CaptureFixInput {
  lat: string | null;
  lon: string | null;
  accuracyM: string | null;
  fixAt: string | null;
}
export interface UploadPhotoCommand {
  projectId: string;
  businessDate: string;
  clientMutationId: string;
  source: PhotoSourceDto;
  /** camera only; null = none sent. */
  capture: CaptureFixInput | null;
  /** Device clock at capture (camera only), ISO-8601; null = not sent. */
  takenAt: string | null;
  link: PhotoLinkDto | null;
}
export interface LinkPhotoCommand {
  photoId: string;
  clientMutationId: string;
  /** The photo's linkVersion as last read. */
  expectedVersion: number;
  link: PhotoLinkDto;
}
export interface UnlinkPhotoCommand {
  photoId: string;
  clientMutationId: string;
  expectedVersion: number;
}
/**
 * Whether a photo read carries exact coordinates (OD20): 'exact' for the project's writers;
 * 'withheld' for read-only accounts, which see only whether there is a position (`location`)
 * and the accuracy the device claimed, never where.
 */
export type PhotoCoordinates = 'exact' | 'withheld';
/** A device fix as a photo read shows it; lat/lon are null when coordinates are withheld. */
export interface CaptureFixViewDto {
  lat: string | null;
  lon: string | null;
  accuracyM: string;
  fixAt: string;
}
export interface PhotoDto {
  id: string;
  projectId: string;
  businessDate: string;
  source: PhotoSourceDto;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  /** Device fix of an in-app capture, as declared by the device. */
  capture: CaptureFixViewDto | null;
  deviceCapturedAt: string | null;
  /**
   * What the file itself says (EXIF); album position only. Claims, not verification. `gps` is
   * also null when coordinates are withheld; `location` still says 'file' then.
   */
  file: {
    takenLocal: string | null;
    takenAt: string | null;
    gps: { lat: string; lon: string } | null;
  };
  location: PhotoLocationKind;
  coordinates: PhotoCoordinates;
  hasThumbnail: boolean;
  receivedAt: string;
  uploadedByPersonId: string;
  link: PhotoLinkDto | null;
  /** Number of link changes so far; the next link/unlink sends it as expectedVersion. */
  linkVersion: number;
}
/** A photo as a submission freezes it. */
export interface PhotoAsOfDto {
  id: string;
  source: PhotoSourceDto;
  location: PhotoLocationKind;
  accuracyM: string | null;
  deviceCapturedAt: string | null;
  fileTakenAt: string | null;
  fileTakenLocal: string | null;
  link: PhotoLinkDto | null;
}

/** Latitude/longitude: up to 3 integer digits and 6 decimals (the stored precision). */
const COORD = /^-?\d{1,3}(\.\d{1,6})?$/;
/** Accuracy radius in metres: up to 6 integer digits and 2 decimals. */
const ACCURACY = /^\d{1,6}(\.\d{1,2})?$/;
const CAPTURE_FIELDS = ['lat', 'lon', 'accuracyM', 'fixAt'] as const;
/** Multipart text fields of an upload; anything else is refused. */
export const UPLOAD_PHOTO_FIELDS = [
  'projectId',
  'businessDate',
  'clientMutationId',
  'source',
  ...CAPTURE_FIELDS,
  'takenAt',
  'workItemKey',
  'issueId',
] as const;

const given = (v: unknown) => v !== undefined && v !== null && v !== '';
function pattern(v: unknown, re: RegExp, field: string): string {
  const s = str(v, field, 32);
  if (!re.test(s)) throw new InvalidReportInput(field);
  return s;
}
function timestamp(v: unknown, field: string): string {
  const s = str(v, field, 40);
  if (!isRealTimestamp(s)) throw new InvalidReportInput(field);
  return s;
}
const key = itemKey;
function link(o: Record<string, unknown>): PhotoLinkDto | null {
  const item = given(o['workItemKey']);
  const issue = given(o['issueId']);
  if (item && issue) throw new InvalidReportInput('link');
  if (item) return { type: 'item', id: key(o['workItemKey'], 'workItemKey') };
  if (issue) return { type: 'issue', id: id(o['issueId'], 'issueId') };
  return null;
}

/** Multipart fields (all strings). Unknown fields are refused rather than ignored. */
export function parseUploadPhotoCommand(v: unknown): UploadPhotoCommand {
  const o = obj(v, 'command');
  for (const k of Object.keys(o))
    if (!(UPLOAD_PHOTO_FIELDS as readonly string[]).includes(k))
      throw new InvalidReportInput(k);
  const source = oneOf(o['source'], PHOTO_SOURCES, 'source');
  const anyCapture = CAPTURE_FIELDS.some((k) => given(o[k]));
  // An album upload may happen anywhere: the uploader's position is never recorded.
  if (source === 'album' && (anyCapture || given(o['takenAt'])))
    throw new InvalidReportInput('capture');
  return {
    projectId: id(o['projectId'], 'projectId'),
    businessDate: date(o['businessDate'], 'businessDate'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    source,
    capture: anyCapture
      ? {
          lat: given(o['lat']) ? pattern(o['lat'], COORD, 'lat') : null,
          lon: given(o['lon']) ? pattern(o['lon'], COORD, 'lon') : null,
          accuracyM: given(o['accuracyM'])
            ? pattern(o['accuracyM'], ACCURACY, 'accuracyM')
            : null,
          fixAt: given(o['fixAt']) ? timestamp(o['fixAt'], 'fixAt') : null,
        }
      : null,
    takenAt: given(o['takenAt']) ? timestamp(o['takenAt'], 'takenAt') : null,
    link: link(o),
  };
}
export function parseLinkPhotoCommand(v: unknown): LinkPhotoCommand {
  const o = obj(v, 'command');
  const l = obj(o['link'], 'link');
  const type = oneOf(l['type'], ['item', 'issue'] as const, 'link.type');
  return {
    photoId: id(o['photoId'], 'photoId'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    expectedVersion: version(o['expectedVersion'], 'expectedVersion'),
    link: {
      type,
      id: type === 'item' ? key(l['id'], 'link.id') : id(l['id'], 'link.id'),
    },
  };
}
export function parseUnlinkPhotoCommand(v: unknown): UnlinkPhotoCommand {
  const o = obj(v, 'command');
  return {
    photoId: id(o['photoId'], 'photoId'),
    clientMutationId: id(o['clientMutationId'], 'clientMutationId'),
    expectedVersion: version(o['expectedVersion'], 'expectedVersion'),
  };
}
