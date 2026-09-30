import { describe, expect, it } from 'vitest';
import {
  CHECKED_NO_ISSUES,
  LEGACY_CHECKED_NO_ISSUES,
  MESSAGES,
  narrativeText,
  type Lang,
} from './index.js';

const LANG_LIST: Lang[] = ['zh', 'en', 'sr', 'es'];

describe('quality/safety preset code (ML-06)', () => {
  it('renders the preset code in each language from the dictionary', () => {
    expect(CHECKED_NO_ISSUES).toBe('CHECKED_NO_ISSUES');
    LANG_LIST.forEach((lang, i) => {
      expect(narrativeText(CHECKED_NO_ISSUES, lang)).toBe(
        MESSAGES.noCheckFound[i],
      );
    });
    expect(narrativeText(CHECKED_NO_ISSUES, 'en')).toBe('Checked, no issues');
    expect(narrativeText(CHECKED_NO_ISSUES, 'sr')).toBe(
      'Provereno, bez problema',
    );
  });

  it('maps exactly the legacy Chinese preset to the same per-language text', () => {
    expect(LEGACY_CHECKED_NO_ISSUES).toBe('检查未见问题');
    expect(narrativeText('检查未见问题', 'es')).toBe(
      'Revisado, sin incidencias',
    );
    expect(narrativeText('检查未见问题', 'en')).toBe('Checked, no issues');
  });

  it('leaves free text exactly as typed, including near-misses of the preset', () => {
    for (const typed of [
      '',
      ' ',
      '模板支撑已检查',
      '检查未见问题 ',
      ' 检查未见问题',
      '检查未见问题。',
      'checked_no_issues',
      'CHECKED_NO_ISSUES extra',
      'Checked, no issues',
    ]) {
      for (const lang of LANG_LIST) {
        expect(narrativeText(typed, lang)).toBe(typed);
      }
    }
  });
});
