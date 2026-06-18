import { describe, expect, it } from 'vitest';
import { buildThemeHead } from './buildThemeStyle';

describe('buildThemeHead', () => {
  const head = buildThemeHead({ brand: '#8c6cff', accent: '#ff6b35', fontKey: 'inter-fraunces' });

  it('emits inline self-hosted @font-face for the chosen font (no remote fetch)', () => {
    expect(head).toContain('<style id="mkpdfs-fonts">');
    expect(head).toContain('@font-face');
    expect(head).toContain('src: url(data:font/woff2;base64,');
    expect(head).toContain("font-family: 'Fraunces'");
    expect(head).not.toContain('fonts.googleapis.com');
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
