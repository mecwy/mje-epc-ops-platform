import { describe, expect, it } from 'vitest';
import type { FieldErrorCode } from '@mje/domain';
import { MESSAGES, translate, type MessageKey } from '@mje/ui';
import { FIELD_ERRORS, fieldErrorKey, type KnownFieldCode } from './errors.js';

// Compile-time: every code the domain can throw has a message (tsc fails when one is added).
const everyDomainCode: Record<FieldErrorCode, MessageKey> = FIELD_ERRORS;
const adoptCodes: KnownFieldCode[] = [
  'FOREMAN_TOTAL_CHANGED',
  'ADOPT_NOT_COMPLETE',
  'LOCKED',
  'READ_ONLY',
];

describe('field error messages', () => {
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
  it('gives the check-in refusals distinct, specific messages', () => {
    const refusals: KnownFieldCode[] = [
      'GEOFENCE_OUTSIDE',
      'LOCATION_TOO_COARSE',
      'SITE_NOT_CONFIGURED',
      'FIX_TIME_INVALID',
      'TIME_ORDER_INVALID',
      'DEVICE_CLOCK_SKEW',
      'TOO_LATE',
      'BUSINESS_DAY_MISMATCH',
      'ALREADY_CHECKED_IN',
      'DEVICE_PENDING',
      'DEVICE_ENDED',
      'SELFIE_EXPIRED',
      'FEATURE_OFF',
    ];
    const keys = refusals.map((c) => fieldErrorKey(c));
    expect(new Set(keys).size).toBe(refusals.length);
    expect(translate('en', fieldErrorKey('GEOFENCE_OUTSIDE'))).toMatch(
      /outside the site area/,
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
