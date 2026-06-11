import { randomBytes, randomInt } from 'crypto';

// No 0/O/1/I — unambiguous for humans reading a terminal. 32^8 ≈ 1.1e12 (~40 bits).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const generateUserCode = (): string =>
  Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

export const generateDeviceCode = (): string => randomBytes(32).toString('hex');

export const formatUserCode = (code: string): string =>
  `${code.slice(0, 4)}-${code.slice(4)}`;

// Substitute misread characters after uppercasing: 0→O, 1→I (and l→I via
// uppercasing). The alphabet excludes 0/O/1/I, so a typed 0 or 1 is always
// a misreading of the letter form.
export const normalizeUserCode = (input: string): string =>
  input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/0/g, 'O')
    .replace(/1/g, 'I');
