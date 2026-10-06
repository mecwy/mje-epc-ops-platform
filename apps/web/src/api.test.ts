import { describe, expect, it, vi } from 'vitest';
import {
  reportApi,
  responseCode,
  uploadForm,
  type PhotoUpload,
} from './api.js';
import { photoErrorKey } from './report/Photos.js';

const base: PhotoUpload = {
  projectId: 'p',
  businessDate: '2026-10-01',
  clientMutationId: 'k1',
  source: 'album',
  photo: new Blob([new Uint8Array([1, 2, 3])]),
  mediaType: 'image/jpeg',
  thumbnail: null,
  fix: null,
  takenAt: null,
  link: null,
};

describe('status refusal metadata', () => {
  it('preserves the lost-attempt flag together with sanitized fields on transport resend', async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      if (calls++ === 0) throw Error('TEST lost response');
      return new Response(
        JSON.stringify({
          code: 'STATUS_FIELDS_REQUIRED',
          fields: ['recovery'],
        }),
        { status: 400 },
      );
    });
    try {
      const result = reportApi(async () => 'TEST-token')
        .projectStatus('TEST-project')
        .catch((error) => error as unknown);
      await vi.runAllTimersAsync();
      await expect(result).resolves.toMatchObject({
        code: 'STATUS_FIELDS_REQUIRED',
        afterLostAttempt: true,
        fields: ['recovery'],
      });
      expect(calls).toBe(2);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
  it.each([
    [
      ['areas', 'recovery', 'areas'],
      ['areas', 'recovery'],
    ],
    [['areas', 'TEST-private-text'], []],
    [['areas', 42], []],
    ['areas', []],
    [null, []],
  ])(
    'keeps only a wholly valid fixed field-name list (%j)',
    async (fields, expected) => {
      vi.stubGlobal(
        'fetch',
        async () =>
          new Response(
            JSON.stringify({
              code: 'STATUS_FIELDS_REQUIRED',
              fields,
              message: 'TEST response text must not survive',
            }),
            { status: 400 },
          ),
      );
      try {
        await expect(
          reportApi(async () => 'TEST-token').declareProjectStatus({
            projectId: 'TEST-project',
            expectedN: 0,
            clientMutationId: 'TEST-key',
            status: 'AT_RISK',
            areas: [],
            situation: '',
            recovery: '',
            expectedRecoveryDate: null,
            expectedRecoveryUnknown: false,
            needsSupport: false,
            supportNote: '',
          }),
        ).rejects.toMatchObject({
          code: 'STATUS_FIELDS_REQUIRED',
          status: 400,
          fields: expected,
          message: 'STATUS_FIELDS_REQUIRED',
        });
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
  it('does not retain field metadata for unrelated refusals', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ code: 'READ_ONLY', fields: ['areas'] }), {
          status: 403,
        }),
    );
    try {
      await expect(
        reportApi(async () => 'TEST-token').projectStatus('TEST-project'),
      ).rejects.toMatchObject({ code: 'READ_ONLY', fields: [] });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('photo API boundary', () => {
  it('keeps only a well-formed code from an error response, never its text', () => {
    expect(responseCode(409, '{"code":"PHOTO_ELSEWHERE"}')).toBe(
      'PHOTO_ELSEWHERE',
    );
    expect(responseCode(500, '<html><body>stack trace</body></html>')).toBe(
      'REQUEST_FAILED',
    );
    expect(responseCode(409, '{"code":"<img src=x onerror=alert(1)>"}')).toBe(
      'REQUEST_FAILED',
    );
    expect(responseCode(400, '{"code":"a lowercase message"}')).toBe(
      'REQUEST_FAILED',
    );
    expect(responseCode(400, '{"code":42}')).toBe('REQUEST_FAILED');
    expect(responseCode(400, 'null')).toBe('REQUEST_FAILED');
    // A gateway refusing the body size without the API's JSON.
    expect(responseCode(413, '<html>Request Entity Too Large</html>')).toBe(
      'PHOTO_TOO_LARGE',
    );
  });

  it('shows a message chosen for the code; anything unknown is the generic failure', () => {
    expect(photoErrorKey('PHOTO_TOO_LARGE')).toBe('photoTooLarge');
    expect(photoErrorKey('denied')).toBe('locDenied');
    expect(photoErrorKey('SOMETHING_NEW')).toBe('saveFail');
    expect(photoErrorKey('<script>')).toBe('saveFail');
    expect(photoErrorKey(null)).toBeNull();
  });

  it('an album upload carries no position or device time; empty parts are not sent', () => {
    const form = uploadForm({ ...base, link: { type: 'item', id: 'support' } });
    expect([...form.keys()]).toEqual([
      'projectId',
      'businessDate',
      'clientMutationId',
      'source',
      'workItemKey',
      'photo',
    ]);
    expect(form.get('workItemKey')).toBe('support');
    // The device's own file name is not sent.
    expect((form.get('photo') as File).name).toBe('photo');
    expect((form.get('photo') as File).type).toBe('image/jpeg');
  });

  it('an in-app upload carries the fix exactly as taken, and its link', () => {
    const form = uploadForm({
      ...base,
      source: 'camera',
      thumbnail: new Blob(['t'], { type: 'image/jpeg' }),
      fix: {
        lat: '-33.000001',
        lon: '151.000002',
        accuracyM: '7.50',
        fixAt: '2026-10-01T07:59:59.000Z',
      },
      takenAt: '2026-10-01T08:00:00.000Z',
      link: { type: 'issue', id: 'i1' },
    });
    expect(
      Object.fromEntries(
        [...form.entries()].filter(([, v]) => typeof v === 'string'),
      ),
    ).toEqual({
      projectId: 'p',
      businessDate: '2026-10-01',
      clientMutationId: 'k1',
      source: 'camera',
      lat: '-33.000001',
      lon: '151.000002',
      accuracyM: '7.50',
      fixAt: '2026-10-01T07:59:59.000Z',
      takenAt: '2026-10-01T08:00:00.000Z',
      issueId: 'i1',
    });
    expect(form.has('thumbnail')).toBe(true);
    expect(form.has('workItemKey')).toBe(false);
  });
});
