import { describe, expect, it } from 'vitest';
import {
  InvalidReportInput,
  parseLinkPhotoCommand,
  parseUnlinkPhotoCommand,
  parseUploadPhotoCommand,
} from './index.js';

const P = '11111111-1111-4111-8111-111111111111';
const K = '22222222-2222-4222-8222-222222222222';
const I = '33333333-3333-4333-8333-333333333333';
const camera = {
  projectId: P,
  businessDate: '2026-10-05',
  clientMutationId: K,
  source: 'camera',
  lat: '44.800000',
  lon: '-20.4',
  accuracyM: '12.5',
  fixAt: '2026-10-05T08:00:00Z',
};
const bad = (f: () => unknown, field: string) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(InvalidReportInput);
    expect((e as InvalidReportInput).field).toBe(field);
    return;
  }
  throw new Error(`accepted; expected ${field}`);
};

describe('photo upload fields', () => {
  it('parses a camera capture with its fix and an optional link', () => {
    expect(
      parseUploadPhotoCommand({ ...camera, workItemKey: 'support' }),
    ).toEqual({
      projectId: P,
      businessDate: '2026-10-05',
      clientMutationId: K,
      source: 'camera',
      capture: {
        lat: '44.800000',
        lon: '-20.4',
        accuracyM: '12.5',
        fixAt: '2026-10-05T08:00:00Z',
      },
      takenAt: null,
      link: { type: 'item', id: 'support' },
    });
    expect(
      parseUploadPhotoCommand({ ...camera, issueId: I.toUpperCase() }).link,
    ).toEqual({
      type: 'issue',
      id: I,
    });
  });
  it('a partial fix is passed on as is: the store refuses it (NEEDS_LOCATION), not the parser', () => {
    // '' and absent are the same: not sent.
    expect(
      parseUploadPhotoCommand({ ...camera, fixAt: '' }).capture?.fixAt,
    ).toBeNull();
    const none = { ...camera, lat: '', lon: '', accuracyM: '', fixAt: '' };
    expect(parseUploadPhotoCommand(none).capture).toBeNull();
    // Off-globe but well-formed: also the rule's decision.
    expect(parseUploadPhotoCommand({ ...camera, lat: '91' }).capture?.lat).toBe(
      '91',
    );
  });
  it('an album upload never carries the uploader position or a device time', () => {
    const album = {
      projectId: P,
      businessDate: '2026-10-05',
      clientMutationId: K,
      source: 'album',
    };
    expect(parseUploadPhotoCommand(album).capture).toBeNull();
    bad(() => parseUploadPhotoCommand({ ...album, lat: '44.8' }), 'capture');
    bad(
      () =>
        parseUploadPhotoCommand({ ...album, fixAt: '2026-10-05T08:00:00Z' }),
      'capture',
    );
    bad(
      () =>
        parseUploadPhotoCommand({ ...album, takenAt: '2026-10-05T08:00:00Z' }),
      'capture',
    );
  });
  it('refuses malformed numbers, floats beyond the stored precision, bad times, both links, unknown fields', () => {
    bad(() => parseUploadPhotoCommand({ ...camera, lat: '44.8000001' }), 'lat');
    bad(() => parseUploadPhotoCommand({ ...camera, lon: '1e3' }), 'lon');
    bad(() => parseUploadPhotoCommand({ ...camera, lat: 'NaN' }), 'lat');
    bad(
      () => parseUploadPhotoCommand({ ...camera, accuracyM: '-1' }),
      'accuracyM',
    );
    bad(
      () => parseUploadPhotoCommand({ ...camera, accuracyM: '1.234' }),
      'accuracyM',
    );
    bad(
      () =>
        parseUploadPhotoCommand({ ...camera, fixAt: '2026-02-30T08:00:00Z' }),
      'fixAt',
    );
    bad(
      () => parseUploadPhotoCommand({ ...camera, fixAt: 'yesterday' }),
      'fixAt',
    );
    bad(
      () => parseUploadPhotoCommand({ ...camera, source: 'screenshot' }),
      'source',
    );
    bad(
      () =>
        parseUploadPhotoCommand({ ...camera, workItemKey: 'a', issueId: I }),
      'link',
    );
    bad(
      () => parseUploadPhotoCommand({ ...camera, workItemKey: '1bad' }),
      'workItemKey',
    );
    bad(() => parseUploadPhotoCommand({ ...camera, orgId: P }), 'orgId');
    bad(() => parseUploadPhotoCommand({ ...camera, lat: ['1', '2'] }), 'lat');
    bad(
      () => parseUploadPhotoCommand({ ...camera, businessDate: '2026-13-01' }),
      'businessDate',
    );
  });
});

describe('work-item keys on photos', () => {
  it('accept the shared 64-character limit in upload and link, and refuse 65', () => {
    const k = (n: number) => 'k'.repeat(n);
    for (const n of [1, 32, 33, 64]) {
      expect(
        parseUploadPhotoCommand({ ...camera, workItemKey: k(n) }).link,
      ).toEqual({ type: 'item', id: k(n) });
      expect(
        parseLinkPhotoCommand({
          photoId: P,
          clientMutationId: K,
          expectedVersion: 0,
          link: { type: 'item', id: k(n) },
        }).link.id,
      ).toBe(k(n));
    }
    bad(
      () => parseUploadPhotoCommand({ ...camera, workItemKey: k(65) }),
      'workItemKey',
    );
    bad(
      () =>
        parseLinkPhotoCommand({
          photoId: P,
          clientMutationId: K,
          expectedVersion: 0,
          link: { type: 'item', id: k(65) },
        }),
      'link.id',
    );
  });
});

describe('photo link commands', () => {
  it('link needs one target and the link version', () => {
    expect(
      parseLinkPhotoCommand({
        photoId: P,
        clientMutationId: K,
        expectedVersion: 2,
        link: { type: 'issue', id: I },
      }),
    ).toEqual({
      photoId: P,
      clientMutationId: K,
      expectedVersion: 2,
      link: { type: 'issue', id: I },
    });
    bad(
      () =>
        parseLinkPhotoCommand({
          photoId: P,
          clientMutationId: K,
          expectedVersion: 0,
          link: null,
        }),
      'link',
    );
    bad(
      () =>
        parseLinkPhotoCommand({
          photoId: P,
          clientMutationId: K,
          expectedVersion: 0,
          link: { type: 'task', id: 'x' },
        }),
      'link.type',
    );
    bad(
      () =>
        parseLinkPhotoCommand({
          photoId: P,
          clientMutationId: K,
          expectedVersion: 0,
          link: { type: 'issue', id: 'support' },
        }),
      'link.id',
    );
    bad(
      () =>
        parseLinkPhotoCommand({
          photoId: P,
          clientMutationId: K,
          link: { type: 'item', id: 'support' },
        }),
      'expectedVersion',
    );
    expect(
      parseUnlinkPhotoCommand({
        photoId: P,
        clientMutationId: K,
        expectedVersion: 1,
      }),
    ).toEqual({ photoId: P, clientMutationId: K, expectedVersion: 1 });
  });
});
