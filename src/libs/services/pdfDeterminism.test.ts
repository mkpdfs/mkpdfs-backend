import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXED_PDF_DATE, normalizePdfBytes } from './pdfDeterminism';

const FIXTURES = join(__dirname, '__fixtures__');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const TRAILER = 'trailer\n<</Size 3\n/Root 4 0 R\n/Info 1 0 R>>\nstartxref\n0\n%%EOF\n';

/** A PDF whose Info object is exactly the dictionary body given. */
function withInfoDict(body: string, extra = '', trailer = TRAILER): Buffer {
  return Buffer.from(`%PDF-1.4\n1 0 obj\n<<${body}>>\nendobj\n${extra}${trailer}`, 'latin1');
}

/**
 * Minimal stand-in for what Skia writes: a plain Info object holding the two
 * wall-clock dates, referenced from the trailer.
 */
function chromiumLikePdf(stamp: string, body = 'BT /F1 12 Tf (hola) Tj ET', tz = "+00'00'"): Buffer {
  return withInfoDict(
    '/Creator (Chromium)\n'
    + '/Producer (Skia/PDF m143)\n'
    + `/CreationDate (D:${stamp}${tz})\n`
    + `/ModDate (D:${stamp}${tz})`,
    `2 0 obj\n<</Length ${body.length}>>\nstream\n${body}\nendstream\nendobj\n`,
  );
}

const bail = (input: Buffer, reason: string) => {
  const result = normalizePdfBytes(input);
  expect(result.reason).toBe(reason);
  expect(result.patched).toBe(0);
  expect(result.buffer).toBe(input); // same object, untouched
};

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
      // A malicious/unlucky <title> becomes /Title. It must survive verbatim
      // while the two REAL dates next to it are normalised.
      const evil = "/CreationDate (D:20991231235959+00'00')";
      const pdf = withInfoDict(
        `/Title (${evil})\n`
        + "/CreationDate (D:20260819222710+00'00')\n"
        + "/ModDate (D:20260819222710+00'00')",
      );

      const { buffer, patched } = normalizePdfBytes(pdf);
      expect(patched).toBe(2);
      expect(buffer.toString('latin1')).toContain(`/Title (${evil})`);
      expect(buffer.toString('latin1')).toContain(`/CreationDate (D:${FIXED_PDF_DATE}`);
      expect(buffer.toString('latin1')).toContain(`/ModDate (D:${FIXED_PDF_DATE}`);
    });

    it('does not match a longer key that merely starts with a date key', () => {
      bail(
        withInfoDict("/ModDateOriginal (D:20260819222710+00'00')"),
        'info-date-not-unique:CreationDate:0',
      );
      expect(
        normalizePdfBytes(withInfoDict("/ModDateOriginal (D:20260819222710+00'00')"))
          .buffer.toString('latin1'),
      ).toContain('D:20260819222710');
    });

    it('ignores a date key sitting in a VALUE position', () => {
      // `/Subject /CreationDate` — the name is a value, not a key.
      const pdf = withInfoDict(
        '/Subject /CreationDate\n'
        + "/CreationDate (D:20260819222710+00'00')\n"
        + "/ModDate (D:20260819222710+00'00')",
      );

      const { patched, buffer } = normalizePdfBytes(pdf);
      expect(patched).toBe(2);
      expect(buffer.toString('latin1')).toContain('/Subject /CreationDate');
    });
  });

  // ---------------------------------------------------------------------------
  // The contract is narrow ON PURPOSE: this module normalises the freshly
  // produced output of the approved Chromium/Skia layer, not arbitrary PDFs.
  // Everything below asserts that a deviation is an EXPLICIT contract failure
  // (original returned + specific reason), never a silent partial normalisation.
  // ---------------------------------------------------------------------------

  describe('narrow contract: the date literal must be complete and closed', () => {
    it('normalises a varying time-zone suffix, not just the digits', () => {
      // Same instant, two host time zones. Before the suffix was normalised
      // these two hashed differently even though every other byte matched.
      const utc = normalizePdfBytes(chromiumLikePdf('20260819222710', undefined, "+00'00'"));
      const pacific = normalizePdfBytes(chromiumLikePdf('20260819152710', undefined, "-07'00'"));

      expect(utc.patched).toBe(2);
      expect(pacific.patched).toBe(2);
      expect(sha256(utc.buffer)).toBe(sha256(pacific.buffer));
      expect(pacific.buffer.toString('latin1')).toContain(`(D:${FIXED_PDF_DATE}+00'00')`);
    });

    it('accepts the other well-known suffix shapes and canonicalises them', () => {
      for (const tz of ['', 'Z', "Z00'00'", "+05'30'", "-03'00", "+02'", '+09']) {
        const result = normalizePdfBytes(chromiumLikePdf('20260819222710', undefined, tz));
        expect(result.reason).toBeUndefined();
        expect(result.patched).toBe(2);
        // The replacement is always the same byte length as what it replaced.
        expect(result.buffer.length).toBe(chromiumLikePdf('20260819222710', undefined, tz).length);
      }
    });

    it('rejects an unrecognised time-zone suffix instead of leaving it varying', () => {
      // `+0000` (no apostrophes) is not a shape we know; normalising the digits
      // alone would leave a suffix that still varies with the host time zone.
      bail(chromiumLikePdf('20260819222710', undefined, '+0000'), 'date-literal-out-of-contract:CreationDate');
    });

    it('rejects trailing content between the stamp and the closing parenthesis', () => {
      bail(
        withInfoDict(
          "/CreationDate (D:20260819222710 stray text)\n"
          + "/ModDate (D:20260819222710+00'00')",
        ),
        'date-literal-out-of-contract:CreationDate',
      );
    });

    it('rejects a stamp that is not exactly 14 digits', () => {
      for (const stamp of ['2026081922271', '202608192227101', '20260819']) {
        bail(
          withInfoDict(
            `/CreationDate (D:${stamp}+00'00')\n`
            + "/ModDate (D:20260819222710+00'00')",
          ),
          'date-literal-out-of-contract:CreationDate',
        );
      }
    });

    it('rejects a 14-digit stamp whose fields are impossible', () => {
      for (const stamp of ['20261319222710', '20260800222710', '20260819992710', '20260819226010']) {
        bail(
          withInfoDict(
            "/CreationDate (D:20260819222710+00'00')\n"
            + `/ModDate (D:${stamp}+00'00')`,
          ),
          'date-literal-out-of-contract:ModDate',
        );
      }
    });

    it('rejects a date literal that is never closed', () => {
      bail(
        Buffer.from(
          '%PDF-1.4\n1 0 obj\n'
          + "<</CreationDate (D:20260819222710+00'00'\n"
          + "/ModDate (D:20260819222710+00'00')>>\nendobj\n" + TRAILER,
          'latin1',
        ),
        'info-dictionary-unparsable',
      );
    });
  });

  describe('narrow contract: exactly two dates, direct entries of /Info', () => {
    it('rejects an Info dictionary with only one of the two dates', () => {
      bail(
        withInfoDict("/Creator (Chromium)\n/CreationDate (D:20260819222710+00'00')"),
        'info-date-not-unique:ModDate:0',
      );
    });

    it('rejects a duplicated date key rather than guessing which one wins', () => {
      bail(
        withInfoDict(
          "/CreationDate (D:20260819222710+00'00')\n"
          + "/CreationDate (D:20270101010101+00'00')\n"
          + "/ModDate (D:20260819222710+00'00')",
        ),
        'info-date-not-unique:CreationDate:2',
      );
    });

    it('rejects a date key nested inside a sub-dictionary of /Info', () => {
      bail(
        withInfoDict(
          "/CreationDate (D:20260819222710+00'00')\n"
          + "/ModDate (D:20260819222710+00'00')\n"
          + "/Custom <</CreationDate (D:20991231235959+00'00')>>",
        ),
        'date-key-nested',
      );
    });

    it('rejects a date key nested inside an array of dictionaries', () => {
      bail(
        withInfoDict(
          "/CreationDate (D:20260819222710+00'00')\n"
          + "/ModDate (D:20260819222710+00'00')\n"
          + "/History [<</ModDate (D:20991231235959+00'00')>>]",
        ),
        'date-key-nested',
      );
    });

    it('rejects a date key living in another object outside /Info', () => {
      bail(
        withInfoDict(
          "/CreationDate (D:20260819222710+00'00')\n"
          + "/ModDate (D:20260819222710+00'00')",
          "7 0 obj\n<</Type /Foo /ModDate (D:20991231235959+00'00')>>\nendobj\n",
        ),
        'date-key-outside-info',
      );
    });

    it('rejects an Info object that is not a plain `<<...>> endobj`', () => {
      bail(
        Buffer.from(
          '%PDF-1.4\n1 0 obj\n[1 2 3]\nendobj\n' + TRAILER,
          'latin1',
        ),
        'info-dictionary-unparsable',
      );
      bail(
        Buffer.from(
          '%PDF-1.4\n1 0 obj\n'
          + "<</CreationDate (D:20260819222710+00'00')\n"
          + "/ModDate (D:20260819222710+00'00')>> 42\nendobj\n" + TRAILER,
          'latin1',
        ),
        'info-dictionary-unparsable',
      );
    });

    it('rejects a file that defines the Info object more than once', () => {
      bail(
        Buffer.from(
          '%PDF-1.4\n1 0 obj\n'
          + "<</CreationDate (D:20260819222710+00'00')\n"
          + "/ModDate (D:20260819222710+00'00')>>\nendobj\n"
          + "1 0 obj\n<</CreationDate (D:20270101010101+00'00')\n"
          + "/ModDate (D:20270101010101+00'00')>>\nendobj\n" + TRAILER,
          'latin1',
        ),
        'info-object-ambiguous',
      );
    });

    it('rejects a file whose /Info references disagree', () => {
      bail(
        Buffer.from(
          '%PDF-1.4\n1 0 obj\n<</Foo 1>>\nendobj\n'
          + 'trailer\n<</Info 1 0 R>>\ntrailer\n<</Info 5 0 R>>\nstartxref\n0\n%%EOF\n',
          'latin1',
        ),
        'info-reference-ambiguous',
      );
    });
  });

  describe('narrow contract: structures we refuse to touch', () => {
    const structural = (extra: string, reason: string, trailer = TRAILER) => {
      bail(
        withInfoDict(
          "/CreationDate (D:20260819222710+00'00')\n"
          + "/ModDate (D:20260819222710+00'00')",
          extra,
          trailer,
        ),
        reason,
      );
    };

    it('refuses an encrypted PDF (its dates are ciphertext)', () => {
      structural(
        '',
        'encrypted',
        'trailer\n<</Size 3\n/Info 1 0 R\n/Encrypt 9 0 R>>\nstartxref\n0\n%%EOF\n',
      );
    });

    it('refuses a digitally signed PDF (an edit invalidates the signature)', () => {
      structural('7 0 obj\n<</Type /Sig /Contents <00>>>\nendobj\n', 'digitally-signed');
      structural('7 0 obj\n<</ByteRange [0 100 200 300]>>\nendobj\n', 'digitally-signed');
      structural('7 0 obj\n<</SigFlags 3>>\nendobj\n', 'digitally-signed');
    });

    it('refuses a PDF with incremental updates (older revisions stay referenced)', () => {
      structural('', 'incremental-update', `${TRAILER}${TRAILER}`);
      structural(
        '',
        'incremental-update',
        'trailer\n<</Info 1 0 R>>\nstartxref\n0\nstartxref\n120\n%%EOF\n',
      );
    });

    it('refuses a PDF carrying XMP metadata (a second copy of the dates)', () => {
      structural('7 0 obj\n<</Type /Catalog /Metadata 8 0 R>>\nendobj\n', 'xmp-metadata');
    });

    it('does not mistake customer text for a structural marker', () => {
      // A <title> of `budget/Sig` or `report/Metadata` must not be read as a
      // signature or as XMP: those hits sit inside the Info object's strings.
      const pdf = withInfoDict(
        '/Title (budget/Sig report/Metadata /Encrypt %%EOF startxref)\n'
        + "/CreationDate (D:20260819222710+00'00')\n"
        + "/ModDate (D:20260819222710+00'00')",
      );

      const result = normalizePdfBytes(pdf);
      expect(result.reason).toBeUndefined();
      expect(result.patched).toBe(2);
      expect(result.buffer.toString('latin1')).toContain('/Title (budget/Sig report/Metadata');
    });

    it('still refuses when the marker is a real key of the Info dictionary', () => {
      bail(
        withInfoDict(
          "/CreationDate (D:20260819222710+00'00')\n"
          + "/ModDate (D:20260819222710+00'00')\n"
          + '/Metadata 8 0 R',
        ),
        'out-of-contract-key-in-info',
      );
    });
  });

  describe('the result is all-or-nothing', () => {
    it('patches exactly two literals or none at all', () => {
      const ok = normalizePdfBytes(chromiumLikePdf('20260819222710'));
      expect(ok.patched).toBe(2);

      // Every rejection path above returns 0 — never 1, never 3.
      const partials = [
        withInfoDict("/CreationDate (D:20260819222710+00'00')"),
        withInfoDict("/ModDate (D:20260819222710+00'00')"),
        withInfoDict(
          "/CreationDate (D:20260819222710+00'00')\n"
          + "/ModDate (D:20260819222710+00'00')\n"
          + "/Extra <</ModDate (D:20260819222710+00'00')>>",
        ),
      ];
      for (const input of partials) {
        const result = normalizePdfBytes(input);
        expect(result.patched).toBe(0);
        expect(result.buffer).toBe(input);
        expect(result.reason).toBeTruthy();
      }
    });
  });

  describe('fail-safe: always returns the original', () => {
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
        withInfoDict(
          '/CreationDate (2026-08-19T22:27:10Z)\n'
          + "/ModDate (D:20260819222710+00'00')",
        ),
        'date-literal-out-of-contract:CreationDate',
      );
    });

    it('returns the original when the date is an indirect reference', () => {
      bail(
        withInfoDict("/CreationDate 5 0 R\n/ModDate (D:20260819222710+00'00')"),
        'date-literal-out-of-contract:CreationDate',
      );
    });

    it('returns the original when the date is a hex string', () => {
      bail(
        withInfoDict("/CreationDate <FEFF0044003A>\n/ModDate (D:20260819222710+00'00')"),
        'date-literal-out-of-contract:CreationDate',
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
        Buffer.from(`%PDF-1.4\n1 0 obj\n<</Custom <</Deep ${'['.repeat(2000)}`, 'latin1'),
        Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(4096, 0xff)]),
      ];
      for (const input of cases) {
        expect(() => normalizePdfBytes(input)).not.toThrow();
        expect(normalizePdfBytes(input).buffer.length).toBe(input.length);
        expect(normalizePdfBytes(input).patched).toBe(0);
      }
    });
  });
});
