import { describe, expect, it } from 'vitest';
import { buildThemeHead } from './buildThemeStyle';

describe('buildThemeHead', () => {
  const head = buildThemeHead({ brand: '#8c6cff', accent: '#ff6b35', fontKey: 'inter-fraunces' });

  it('emits a google-fonts stylesheet link for the chosen font', () => {
    expect(head).toContain('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?');
    expect(head).toContain('Fraunces');
  });

  it('emits a :root override with brand/accent + derived tokens + font stacks', () => {
    expect(head).toContain('--brand: #8c6cff;');
    expect(head).toContain('--accent: #ff6b35;');
    expect(head).toContain('--brand-soft:');
    expect(head).toContain('--brand-shadow: rgba(140, 108, 255, 0.28);');
    expect(head).toContain('--accent-soft:');
    expect(head).toContain("--font-heading: 'Fraunces'");
    expect(head).toContain("--font-body: 'Inter'");
  });
});
