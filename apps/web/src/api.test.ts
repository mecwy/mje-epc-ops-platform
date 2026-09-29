import { describe, expect, it } from 'vitest';
import { responseCode, uploadForm, type PhotoUpload } from './api.js';
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
