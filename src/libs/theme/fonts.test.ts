import { describe, expect, it } from 'vitest';
import { FONTS, isFontKey, DEFAULT_FONT_KEY } from './fonts';

describe('font registry', () => {
  it('every font has a label, https google-fonts link, and non-empty stacks', () => {
    for (const [key, f] of Object.entries(FONTS)) {
      expect(f.label, key).toBeTruthy();
      expect(f.linkHref, key).toMatch(/^https:\/\/fonts\.googleapis\.com\/css2\?/);
      expect(f.headingStack, key).toContain(',');
      expect(f.bodyStack, key).toContain(',');
    }
  });

  it('isFontKey accepts registry keys and rejects others', () => {
    expect(isFontKey(DEFAULT_FONT_KEY)).toBe(true);
    expect(isFontKey('inter-fraunces')).toBe(true);
    expect(isFontKey('not-a-font')).toBe(false);
    expect(isFontKey('')).toBe(false);
    expect(isFontKey(undefined as any)).toBe(false);
  });
});
