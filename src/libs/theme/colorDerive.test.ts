import { describe, expect, it } from 'vitest';
import { softTint, shadowRgba } from './colorDerive';

describe('colorDerive', () => {
  it('softTint blends the color 8% over white → near-white hex', () => {
    // pure black at 8% over white = #ebebeb (0.92*255 ≈ 235)
    expect(softTint('#000000')).toBe('#ebebeb');
    // white stays white
    expect(softTint('#ffffff')).toBe('#ffffff');
  });

  it('softTint accepts 3-digit hex', () => {
    expect(softTint('#000')).toBe('#ebebeb');
  });

  it('shadowRgba produces an rgba() string from a hex + alpha', () => {
    expect(shadowRgba('#8C6CFF', 0.28)).toBe('rgba(140, 108, 255, 0.28)');
  });
});
