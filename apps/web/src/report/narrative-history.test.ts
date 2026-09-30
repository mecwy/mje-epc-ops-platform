import { describe, expect, it } from 'vitest';
import { narrativeText } from '@mje/ui';

/** Deep-freeze so any attempt to write the stored snapshot throws. */
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
}

// A submitted version as stored: the Chinese preset from before the code existed, a free-text
// safety note, and the code written by the new button on a later revision.
const STORED_V1 = JSON.stringify({
  narrative: {
    construction: 'TEST 浇筑',
    quality: '检查未见问题',
    safety: '围挡已补',
  },
});
const STORED_V2 = JSON.stringify({
  narrative: {
    construction: 'TEST 浇筑',
    quality: 'CHECKED_NO_ISSUES',
    safety: 'CHECKED_NO_ISSUES',
  },
});

describe('history render of the preset', () => {
  it('shows the mapped text for an old snapshot without changing its stored bytes', () => {
    const before = STORED_V1;
    const snap = freeze(JSON.parse(before)) as {
      narrative: { quality: string; safety: string; construction: string };
    };
    expect(narrativeText(snap.narrative.quality, 'en')).toBe(
      'Checked, no issues',
    );
    expect(narrativeText(snap.narrative.quality, 'sr')).toBe(
      'Provereno, bez problema',
    );
    // free text in the same snapshot is untouched, and so is the stored value itself
    expect(narrativeText(snap.narrative.safety, 'en')).toBe('围挡已补');
    expect(snap.narrative.quality).toBe('检查未见问题');
    expect(JSON.stringify(snap)).toBe(before);
  });

  it('renders the code of a newer revision per language, old and new agree', () => {
    const v1 = JSON.parse(STORED_V1) as { narrative: { quality: string } };
    const v2 = JSON.parse(STORED_V2) as { narrative: { quality: string } };
    for (const lang of ['zh', 'en', 'sr', 'es'] as const) {
      expect(narrativeText(v2.narrative.quality, lang)).toBe(
        narrativeText(v1.narrative.quality, lang),
      );
    }
  });
});
