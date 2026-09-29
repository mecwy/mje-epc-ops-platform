import { describe, expect, it } from 'vitest';
import {
  fmtFileLocal,
  fmtNum,
  fmtStamp,
  shift,
  shown,
  siteToday,
} from './format.js';

describe('report formatting', () => {
  it('groups decimals without float conversion and keeps the text exact', () => {
    expect(fmtNum('5380', 'en-GB')).toBe('5,380');
    expect(fmtNum('99999999999999.999999', 'en-GB')).toBe(
      '99,999,999,999,999.999999',
    );
    expect(fmtNum('1,5', 'en-GB')).toBe('1.5');
    // Spanish groups only from five digits; the decimal comma never doubles as a separator
    expect(fmtNum('1234.5', 'es-ES')).toBe('1234,5');
    expect(fmtNum('12345.5', 'es-ES')).toBe('12.345,5');
    expect(fmtNum('12345.25', 'sr-Latn-RS')).toBe('12.345,25');
    expect(fmtNum('12345', 'zh-CN')).toBe('12,345');
    expect(fmtNum('unknown', 'en-GB')).toBe('unknown');
  });
  it('keeps blank, explicit zero, tokens and invalid text distinct', () => {
    expect(shown('', 'en-GB')).toEqual({ kind: 'blank' });
    expect(shown('0', 'en-GB')).toEqual({ kind: 'number', text: '0' });
    expect(shown('na', 'en-GB')).toEqual({ kind: 'token', token: 'na' });
    expect(shown('12a', 'en-GB')).toEqual({ kind: 'invalid', raw: '12a' });
  });
  it('uses the site timezone for the business date, not the device clock', () => {
    // 23:30 UTC on 29 Sep is already 30 Sep in Belgrade (UTC+2)
    const late = new Date('2026-09-29T23:30:00Z');
    expect(siteToday('Europe/Belgrade', late)).toBe('2026-09-30');
    expect(siteToday('UTC', late)).toBe('2026-09-29');
    expect(shift('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('shows a file clock as written and device instants on the site clock', () => {
    // A file time has no zone: it is shown as the file states it, never shifted.
    expect(fmtFileLocal('2026-09-29T23:59:58')).toBe('2026-09-29 23:59');
    // An instant is shown in the site timezone, whatever the device's zone is.
    expect(
      fmtStamp('2026-09-29T23:30:00.000Z', 'en-GB', 'Europe/Belgrade'),
    ).toBe('30/09, 01:30');
  });
});
