import { describe, expect, it } from 'vitest';
import Handlebars from 'handlebars';
import { PdfService } from './pdfService';

describe('PdfService.composeHtml', () => {
  const tpl = Handlebars.compile(
    '<html><head><style>:root{--brand:#000}</style></head>' +
    '<body>{{mkpdfsLogo companyName}}|{{today}}|{{companyName}}</body></html>',
  );

  it('with no theme: renders defaults, no injected theme style, system params present', () => {
    const html = PdfService.composeHtml(tpl, { companyName: 'Acme' }, undefined,
      { today: '2026-06-16', now: 'x', year: 2026 });
    expect(html).not.toContain('id="mkpdfs-theme"');
    expect(html).toContain('<div class="brand-dot">A</div>'); // fallback mark
    expect(html).toContain('|2026-06-16|Acme');
  });

  it('with theme: injects :root override + font link, logo becomes an <img> data-uri', () => {
    const html = PdfService.composeHtml(
      tpl,
      { companyName: 'Acme' },
      { brand: '#8c6cff', accent: '#ff6b35', fontKey: 'inter-inter',
        logoDataUri: 'data:image/png;base64,AAAA' },
      { today: '2026-06-16', now: 'x', year: 2026 },
    );
    expect(html).toContain('id="mkpdfs-theme"');
    expect(html).toContain('--brand: #8c6cff;');
    // Fonts are self-hosted now: inline @font-face data: URIs, no remote fetch.
    expect(html).toContain('id="mkpdfs-fonts"');
    expect(html).toContain('@font-face');
    expect(html).toContain('src: url(data:font/woff2;base64,');
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).toContain('<img class="brand-logo" src="data:image/png;base64,AAAA"');
    expect(html).not.toContain('brand-dot');
  });

  it('mkpdfsFontFaces helper: expands to inline @font-face data URIs (marketplace path)', () => {
    // Helper is registered at module load when PdfService is imported.
    const t = Handlebars.compile('<style>{{{mkpdfsFontFaces}}} body{}</style>');
    const out = t({});
    expect(out).toContain('@font-face');
    expect(out).toContain('src: url(data:font/woff2;base64,');
    expect(out).not.toContain('fonts.googleapis.com');

    // A known key resolves; an unknown key falls back to the default pair.
    expect(Handlebars.compile('{{{mkpdfsFontFaces "poppins-poppins"}}}')({})).toContain('@font-face');
    expect(Handlebars.compile('{{{mkpdfsFontFaces "nope"}}}')({})).toContain('@font-face');
  });

  it('batch arrays: each page gets system params and the theme', () => {
    const html = PdfService.composeHtml(
      tpl,
      [{ companyName: 'A' }, { companyName: 'B' }],
      { brand: '#000000', accent: '#000000', fontKey: 'inter-inter', logoDataUri: null },
      { today: '2026-06-16', now: 'x', year: 2026 },
    );
    expect(html).toContain('|2026-06-16|A');
    expect(html).toContain('|2026-06-16|B');
    expect(html).toContain('page-break-after');
    expect(html.match(/id="mkpdfs-theme"/g)).toHaveLength(1); // injected once
  });
});
