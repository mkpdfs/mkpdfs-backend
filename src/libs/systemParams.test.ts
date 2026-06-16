import { describe, expect, it } from 'vitest';
import { buildSystemParams } from './systemParams';

describe('buildSystemParams', () => {
  it('returns today (YYYY-MM-DD), now (ISO) and year from the given clock', () => {
    const d = new Date('2026-06-16T13:45:00.000Z');
    expect(buildSystemParams(d)).toEqual({
      today: '2026-06-16',
      now: '2026-06-16T13:45:00.000Z',
      year: 2026,
    });
  });
});
