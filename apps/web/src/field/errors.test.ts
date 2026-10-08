import { describe, expect, it } from 'vitest';
import type { FieldErrorCode } from '@mje/domain';
import { MESSAGES, translate, type MessageKey } from '@mje/ui';
import {
  FIELD_ERRORS,
  UNKNOWN_OUTCOME,
  fieldErrorKey,
  outcomeKey,
  type KnownFieldCode,
} from './errors.js';

import { UNSETTLED } from './session.js';

// Compile-time: every code the domain can throw has a message (tsc fails when one is added).
const everyDomainCode: Record<FieldErrorCode, MessageKey> = FIELD_ERRORS;
const adoptCodes: KnownFieldCode[] = [
  'FOREMAN_TOTAL_CHANGED',
  'ADOPT_NOT_COMPLETE',
  'LOCKED',
  'READ_ONLY',
];

describe('field error messages', () => {
  it('every unsettled write keeps unknown-outcome guidance for either uncertainty state', () => {
    for (const code of UNSETTLED) {
      expect(Object.hasOwn(UNKNOWN_OUTCOME, code), code).toBe(true);
      for (const uncertain of [false, true]) {
        const key = outcomeKey(code, { write: true, uncertain });
        expect(key, code).toMatch(/^fu_/);
        expect(MESSAGES[key], code).toHaveLength(4);
        for (const text of MESSAGES[key])
          expect(text.trim(), code).not.toBe('');
      }
    }
    expect(
      outcomeKey('SOURCE_UNAVAILABLE', { write: true, uncertain: false }),
    ).toBe('fu_server');
    expect(
      outcomeKey('SOURCE_UNAVAILABLE', { write: true, uncertain: true }),
    ).toBe('fu_server');
    expect(
      outcomeKey('SOURCE_UNAVAILABLE', { write: false, uncertain: false }),
    ).toBe(fieldErrorKey('SOURCE_UNAVAILABLE'));
    expect(
      outcomeKey('SOURCE_UNAVAILABLE', { write: false, uncertain: true }),
    ).toBe(fieldErrorKey('SOURCE_UNAVAILABLE'));
  });
  it('gives required status fields safe guidance without changing uncertain outcome priority', () => {
    expect(fieldErrorKey('STATUS_FIELDS_REQUIRED')).toBe(
      'fe_statusFieldsRequired',
    );
    expect(
      outcomeKey('STATUS_FIELDS_REQUIRED', { write: true, uncertain: true }),
    ).toBe('fe_statusFieldsRequired');
    expect(outcomeKey('REQUEST_FAILED', { write: true, uncertain: true })).toBe(
      'fu_server',
    );
    expect(outcomeKey('READ_ONLY', { write: true, uncertain: true })).toBe(
      'fe_accessMaybeRecorded',
    );
  });
  it('maps every domain, adoption and transport code to a four-language message', () => {
    const codes = Object.keys(FIELD_ERRORS) as KnownFieldCode[];
    expect(codes).toEqual(expect.arrayContaining(Object.keys(everyDomainCode)));
    expect(codes).toEqual(expect.arrayContaining(adoptCodes));
    for (const code of codes) {
      const key = fieldErrorKey(code);
      const row = MESSAGES[key];
      expect(row, code).toHaveLength(4);
      for (const text of row) expect(text.trim(), code).not.toBe('');
    }
  });
  it('gives every code its own message (INVALID_JSON is the transport form of INVALID_INPUT)', () => {
    const byKey = new Map<string, string[]>();
    for (const code of Object.keys(FIELD_ERRORS)) {
      const key = fieldErrorKey(code);
      byKey.set(key, [...(byKey.get(key) ?? []), code]);
    }
    const shared = [...byKey.values()].filter((codes) => codes.length > 1);
    expect(shared).toEqual([['INVALID_INPUT', 'INVALID_JSON']]);
    expect(translate('en', fieldErrorKey('GEOFENCE_OUTSIDE'))).toMatch(
      /outside the site area/,
    );
    expect(translate('en', fieldErrorKey('CREW_CODE_TAKEN'))).toMatch(
      /crew code/,
    );
  });
  it('never shows a raw or unknown code', () => {
    expect(fieldErrorKey('SOMETHING_NEW')).toBe('fe_failed');
    expect(fieldErrorKey('<b>x</b>')).toBe('fe_failed');
    expect(fieldErrorKey(null)).toBe('fe_failed');
    // inherited names are not codes
    expect(fieldErrorKey('constructor')).toBe('fe_failed');
    expect(fieldErrorKey('toString')).toBe('fe_failed');
  });
  it('messages carry no placeholders that could echo a name, code or coordinate', () => {
    for (const code of Object.keys(FIELD_ERRORS))
      for (const text of MESSAGES[fieldErrorKey(code)])
        expect(text, code).not.toMatch(/\{\w+\}/);
  });
});
