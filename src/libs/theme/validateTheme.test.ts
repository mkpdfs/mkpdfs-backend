import { describe, expect, it } from 'vitest';
import { validateThemeFields, ThemeValidationError } from './validateTheme';

describe('validateThemeFields', () => {
  it('accepts valid hex + fontKey and normalizes 3-digit hex to 6-digit lowercase', () => {
    const r = validateThemeFields({ brand: '#FFF', accent: '#8C6CFF', fontKey: 'inter-inter' });
    expect(r).toEqual({ brand: '#ffffff', accent: '#8c6cff', fontKey: 'inter-inter' });
  });

  it('rejects non-hex colors (css-injection guards)', () => {
    for (const bad of ['red', 'rgb(0,0,0)', 'var(--x)', '#12', '#1234567', 'url(x)', '#ff;}', '']) {
      expect(() => validateThemeFields({ brand: bad, accent: '#000000', fontKey: 'inter-inter' }),
        bad).toThrow(ThemeValidationError);
    }
  });

  it('rejects an unknown fontKey', () => {
    expect(() => validateThemeFields({ brand: '#000000', accent: '#000000', fontKey: 'comic' }))
      .toThrow(ThemeValidationError);
  });
});
