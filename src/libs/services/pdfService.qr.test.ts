import { describe, expect, it } from 'vitest';
import Handlebars from 'handlebars';
import './pdfService'; // importing registers helpers at module load

describe('mkpdfsQR helper', () => {
  it('renders an inline SVG QR for a URL', () => {
    const t = Handlebars.compile('<div class="qr">{{{mkpdfsQR verifyUrl}}}</div>');
    const html = t({ verifyUrl: 'https://verify.example.com/abc123' });
    expect(html).toContain('<svg');
    expect(html).toContain('</svg>');
    expect(html).not.toContain('&lt;svg'); // SafeString, not escaped
  });

  it('renders nothing when url is missing', () => {
    const t = Handlebars.compile('[{{{mkpdfsQR verifyUrl}}}]');
    expect(t({})).toBe('[]');
  });

  it('accepts an error-correction hash param', () => {
    const t = Handlebars.compile('{{{mkpdfsQR verifyUrl ec="H"}}}');
    const html = t({ verifyUrl: 'https://verify.example.com/x' });
    expect(html).toContain('<svg');
  });
});
