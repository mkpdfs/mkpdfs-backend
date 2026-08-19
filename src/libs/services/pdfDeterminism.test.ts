import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXED_PDF_DATE, normalizePdfBytes } from './pdfDeterminism';

const FIXTURES = join(__dirname, '__fixtures__');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * Minimal stand-in for what Skia writes: a plain Info object holding the two
 * wall-clock dates, referenced from the trailer.
 */
function chromiumLikePdf(stamp: string, body = 'BT /F1 12 Tf (hola) Tj ET'): Buffer {
  return Buffer.from(
    '%PDF-1.4\n'
    + '1 0 obj\n'
    + '<</Creator (Chromium)\n'
    + '/Producer (Skia/PDF m143)\n'
    + `/CreationDate (D:${stamp}+00'00')\n`
    + `/ModDate (D:${stamp}+00'00')>>\n`
    + 'endobj\n'
    + `2 0 obj\n<</Length ${body.length}>>\nstream\n${body}\nendstream\nendobj\n`
    + 'trailer\n<</Size 3\n/Root 4 0 R\n/Info 1 0 R>>\n'
    + 'startxref\n0\n%%EOF\n',
    'latin1',
  );
}

describe('normalizePdfBytes', () => {
  describe('determinism', () => {
    it('makes two renders of the same content byte-identical', () => {
      const first = normalizePdfBytes(chromiumLikePdf('20260819222710'));
      const second = normalizePdfBytes(chromiumLikePdf('20261231235959'));

      expect(first.patched).toBe(2);
      expect(second.patched).toBe(2);
      expect(sha256(first.buffer)).toBe(sha256(second.buffer));
    });

    it('makes two REAL Chromium renders of the same HTML byte-identical', () => {
      // Fixtures produced by headless Chromium 152 from identical HTML a few
      // seconds apart — the exact scenario this module exists for.
      const a = readFileSync(join(FIXTURES, 'chromium-run-a.pdf'));
      const b = readFileSync(join(FIXTURES, 'chromium-run-b.pdf'));

      expect(sha256(a)).not.toBe(sha256(b)); // raw output is NOT deterministic

      const na = normalizePdfBytes(a);
      const nb = normalizePdfBytes(b);
      expect(na.reason).toBeUndefined();
      expect(nb.reason).toBeUndefined();
      expect(na.patched).toBe(2);
      expect(sha256(na.buffer)).toBe(sha256(nb.buffer));
    });

    it('still produces different bytes for different content', () => {
      const one = normalizePdfBytes(chromiumLikePdf('20260819222710', 'BT (uno) Tj ET'));
      const two = normalizePdfBytes(chromiumLikePdf('20260819222710', 'BT (dos) Tj ET'));

      expect(sha256(one.buffer)).not.toBe(sha256(two.buffer));
    });

    it('is idempotent — normalising twice changes nothing', () => {
      const once = normalizePdfBytes(chromiumLikePdf('20260819222710'));
      const twice = normalizePdfBytes(once.buffer);

      expect(sha256(twice.buffer)).toBe(sha256(once.buffer));
    });
  });

  describe('content preservation', () => {
    it('changes ONLY the date digits and never the byte length', () => {
      const input = readFileSync(join(FIXTURES, 'chromium-run-a.pdf'));
      const { buffer } = normalizePdfBytes(input);

      expect(buffer.length).toBe(input.length);

      const changed: number[] = [];
      for (let i = 0; i < input.length; i += 1) {
        if (buffer[i] !== input[i]) changed.push(i);
      }
      // Two 14-digit stamps; only the digits that actually differ from the
      // constant show up here, so at most 28 bytes and never more.
      expect(changed.length).toBeGreaterThan(0);
      expect(changed.length).toBeLessThanOrEqual(28);

      // Every changed byte sits inside a `(D:...)` literal in the Info object.
      const infoEnd = input.indexOf('endobj');
      for (const index of changed) {
        expect(index).toBeLessThan(infoEnd);
      }
      expect(buffer.toString('latin1')).toContain(`/CreationDate (D:${FIXED_PDF_DATE}`);
      expect(buffer.toString('latin1')).toContain(`/ModDate (D:${FIXED_PDF_DATE}`);
    });

    it('leaves /Producer alone so a Chromium upgrade still changes the hash', () => {
      const { buffer } = normalizePdfBytes(chromiumLikePdf('20260819222710'));
      expect(buffer.toString('latin1')).toContain('/Producer (Skia/PDF m143)');
    });

    it('never rewrites a date that lives inside a user-controlled string value', () => {
      // A malicious/unlucky <title> becomes /Title. It must not be touched.
      const evil = "/CreationDate (D:20991231235959+00'00')";
      const pdf = Buffer.from(
        '%PDF-1.4\n'
        + '1 0 obj\n'
        + `<</Title (${evil})\n`
        + "/CreationDate (D:20260819222710+00'00')>>\n"
        + 'endobj\n'
        + 'trailer\n<</Info 1 0 R>>\n%%EOF\n',
        'latin1',
      );

      const { buffer, patched } = normalizePdfBytes(pdf);
      expect(patched).toBe(1);
      expect(buffer.toString('latin1')).toContain(`/Title (${evil})`);
      expect(buffer.toString('latin1')).toContain(`/CreationDate (D:${FIXED_PDF_DATE}`);
    });

    it('does not match a longer key that merely starts with a date key', () => {
      const pdf = Buffer.from(
        '%PDF-1.4\n1 0 obj\n'
        + "<</ModDateOriginal (D:20260819222710+00'00')>>\nendobj\n"
        + 'trailer\n<</Info 1 0 R>>\n%%EOF\n',
        'latin1',
      );

      const result = normalizePdfBytes(pdf);
      expect(result.patched).toBe(0);
      expect(result.reason).toBe('no-date-literals');
      expect(result.buffer.toString('latin1')).toContain('D:20260819222710');
    });
  });

  describe('fail-safe: always returns the original', () => {
    const bail = (input: Buffer, reason: string) => {
      const result = normalizePdfBytes(input);
      expect(result.reason).toBe(reason);
      expect(result.patched).toBe(0);
      expect(result.buffer).toBe(input); // same object, untouched
    };

    it('returns the original when the buffer is not a PDF', () => {
      bail(Buffer.from('this is not a pdf at all'), 'not-a-pdf');
    });

    it('returns the original for an empty buffer', () => {
      bail(Buffer.alloc(0), 'empty-buffer');
    });

    it('returns the original when there is no /Info reference', () => {
      bail(
        Buffer.from('%PDF-1.4\n1 0 obj\n<</Foo 1>>\nendobj\ntrailer\n<</Size 2>>\n%%EOF\n', 'latin1'),
        'info-object-not-found',
      );
    });

    it('returns the original when the Info object is not a plain object (object stream)', () => {
      // /Info points at object 3, which lives compressed inside an ObjStm —
      // there is no `3 0 obj` in the file, so we must not guess.
      bail(
        Buffer.from(
          '%PDF-1.7\n8 0 obj\n<</Type /ObjStm>>\nstream\nbinary\nendstream\nendobj\n'
          + '9 0 obj\n<</Size 10\n/Root 2 0 R\n/Info 3 0 R\n/Type /XRef>>\nendobj\n%%EOF\n',
          'latin1',
        ),
        'info-object-not-found',
      );
    });

    it('returns the original when the date literal has an unexpected shape', () => {
      bail(
        Buffer.from(
          '%PDF-1.4\n1 0 obj\n<</CreationDate (2026-08-19T22:27:10Z)>>\nendobj\n'
          + 'trailer\n<</Info 1 0 R>>\n%%EOF\n',
          'latin1',
        ),
        'no-date-literals',
      );
    });

    it('returns the original when the date is an indirect reference', () => {
      bail(
        Buffer.from(
          '%PDF-1.4\n1 0 obj\n<</CreationDate 5 0 R>>\nendobj\ntrailer\n<</Info 1 0 R>>\n%%EOF\n',
          'latin1',
        ),
        'no-date-literals',
      );
    });

    it('returns the original when the date is a hex string', () => {
      bail(
        Buffer.from(
          '%PDF-1.4\n1 0 obj\n<</CreationDate <FEFF0044003A>>>\nendobj\ntrailer\n<</Info 1 0 R>>\n%%EOF\n',
          'latin1',
        ),
        'no-date-literals',
      );
    });

    it('returns the original when handed a non-buffer', () => {
      const result = normalizePdfBytes(undefined as unknown as Buffer);
      expect(result.patched).toBe(0);
      expect(result.reason).toBe('empty-buffer');
    });

    it('never throws on truncated or garbage PDF-looking input', () => {
      const cases = [
        Buffer.from('%PDF-1.4\n1 0 obj\n<</CreationDate (D:2026', 'latin1'),
        Buffer.from('%PDF-1.4\ntrailer\n<</Info 1 0 R>>', 'latin1'),
        Buffer.from('%PDF-1.4\n1 0 obj\n<</Title (unterminated', 'latin1'),
        Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(4096, 0xff)]),
      ];
      for (const input of cases) {
        expect(() => normalizePdfBytes(input)).not.toThrow();
        expect(normalizePdfBytes(input).buffer.length).toBe(input.length);
      }
    });
  });
});
