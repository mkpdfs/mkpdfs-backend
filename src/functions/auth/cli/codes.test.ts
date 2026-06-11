import { describe, it, expect } from 'vitest';
import { generateUserCode, generateDeviceCode, formatUserCode, normalizeUserCode } from './codes';

describe('generateUserCode', () => {
  it('produces 8 chars from the unambiguous alphabet', () => {
    for (let i = 0; i < 100; i++) {
      const code = generateUserCode();
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });
  it('produces distinct codes', () => {
    expect(new Set(Array.from({ length: 50 }, generateUserCode)).size).toBe(50);
  });
});

describe('generateDeviceCode', () => {
  it('produces 64 hex chars (256 bits)', () => {
    expect(generateDeviceCode()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('user code formatting', () => {
  it('formats as XXXX-XXXX for display', () => {
    expect(formatUserCode('KXTM49PF')).toBe('KXTM-49PF');
  });
  it('normalizes user input (case, dashes, spaces)', () => {
    expect(normalizeUserCode(' kxtm-49pf ')).toBe('KXTM49PF');
  });
  it('substitutes ambiguous characters (0→O, 1→I)', () => {
    expect(normalizeUserCode('0xtm-49pf')).toBe('OXTM49PF');
    expect(normalizeUserCode('KXTM-49P1')).toBe('KXTM49PI');
  });
});
