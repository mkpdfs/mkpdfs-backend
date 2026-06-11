import { randomBytes, randomInt } from 'crypto';

// No 0/O/1/I — unambiguous for humans reading a terminal. 32^8 ≈ 1.1e12 (~40 bits).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const generateUserCode = (): string =>
  Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

export const generateDeviceCode = (): string => randomBytes(32).toString('hex');

export const formatUserCode = (code: string): string =>
  `${code.slice(0, 4)}-${code.slice(4)}`;

// Note: no character substitution (e.g. 0→O) is possible here — the generation
// alphabet excludes 0, O, 1 and I entirely, so any input containing them is a
// misread with no recoverable mapping. Lookup simply fails with "check your terminal".
export const normalizeUserCode = (input: string): string =>
  input.toUpperCase().replace(/[^A-Z0-9]/g, '');
