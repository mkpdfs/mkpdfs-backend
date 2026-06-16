import { describe, expect, it } from 'vitest';
import { assertSafeLogoUrl, LogoIngestError, extFromContentType } from './logoIngest';

describe('assertSafeLogoUrl', () => {
  it('accepts an https URL with a public host', () => {
    expect(() => assertSafeLogoUrl('https://cdn.example.com/logo.png')).not.toThrow();
  });

  it('rejects non-https schemes', () => {
    expect(() => assertSafeLogoUrl('http://example.com/x.png')).toThrow(LogoIngestError);
    expect(() => assertSafeLogoUrl('file:///etc/passwd')).toThrow(LogoIngestError);
    expect(() => assertSafeLogoUrl('data:image/png;base64,AAAA')).toThrow(LogoIngestError);
  });

  it('rejects localhost / private / link-local / metadata hosts', () => {
    for (const u of [
      'https://localhost/a.png',
      'https://127.0.0.1/a.png',
      'https://10.0.0.5/a.png',
      'https://192.168.1.1/a.png',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/a.png',
    ]) {
      expect(() => assertSafeLogoUrl(u), u).toThrow(LogoIngestError);
    }
  });
});

describe('extFromContentType', () => {
  it('maps allowed image content types to extensions', () => {
    expect(extFromContentType('image/png')).toBe('png');
    expect(extFromContentType('image/jpeg')).toBe('jpg');
    expect(extFromContentType('image/svg+xml')).toBe('svg');
    expect(extFromContentType('image/webp')).toBe('webp');
  });
  it('throws on a disallowed content type', () => {
    expect(() => extFromContentType('text/html')).toThrow(LogoIngestError);
  });
});
