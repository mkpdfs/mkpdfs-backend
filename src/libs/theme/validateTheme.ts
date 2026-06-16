import { isFontKey } from './fonts';

export class ThemeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThemeValidationError';
  }
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function normalizeHex(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HEX_RE.test(value)) {
    throw new ThemeValidationError(`Invalid ${field}: must be a hex color like #RRGGBB`);
  }
  let h = value.slice(1).toLowerCase();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return `#${h}`;
}

/** Validate + normalize the color/font fields. Logo is handled separately. */
export function validateThemeFields(input: {
  brand: unknown;
  accent: unknown;
  fontKey: unknown;
}): { brand: string; accent: string; fontKey: string } {
  const brand = normalizeHex(input.brand, 'brand');
  const accent = normalizeHex(input.accent, 'accent');
  if (!isFontKey(input.fontKey)) {
    throw new ThemeValidationError('Invalid fontKey: not a recognized font');
  }
  return { brand, accent, fontKey: input.fontKey };
}
