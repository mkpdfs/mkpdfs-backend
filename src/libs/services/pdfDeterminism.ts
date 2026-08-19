/**
 * Byte-level determinism for Chromium/Skia PDFs.
 *
 * WHY
 * ---
 * Two `page.pdf()` calls over byte-identical HTML produce byte-identical
 * output EXCEPT for the two wall-clock timestamps Skia stamps into the
 * document information dictionary:
 *
 *   1 0 obj
 *   <</Creator (Chromium)
 *   /Producer (Skia/PDF m152)
 *   /CreationDate (D:20260819222710+00'00')
 *   /ModDate (D:20260819222710+00'00')>>
 *   endobj
 *
 * Measured on Chromium 127 and 152 across five real templates (single page,
 * multi page, embedded webfonts, embedded raster logos, inline SVG QR): the
 * ONLY differing bytes were the 14 digits of those two dates. Skia emits no
 * `/ID`, no XMP `/Metadata`, deterministic font resource names and
 * deterministic Flate streams, so nothing else needs touching.
 *
 * APPROACH
 * --------
 * Overwrite those 14 digits in place with a fixed constant. The replacement is
 * the same length by construction, so every cross-reference offset in the file
 * stays valid and every other byte is preserved bit for bit. That makes the
 * "rendered content is unchanged" claim provable rather than merely tested:
 * the output differs from the input only inside two metadata date literals.
 *
 * A full re-serialisation (pdf-lib load + save) was deliberately rejected: it
 * rewrites the entire document — every object, stream and offset — on PDFs
 * built from arbitrary customer HTML, for no gain over a 28-byte edit.
 *
 * `/Producer` is intentionally NOT normalised. It carries the Chromium
 * milestone, so a renderer upgrade changes the hash — which is exactly what a
 * downstream byte-comparison verifier should notice, because the raster can
 * change with it.
 *
 * SAFETY
 * ------
 * Every failure mode returns the original buffer untouched. This never throws.
 */

/** Fixed timestamp stamped into `/CreationDate` and `/ModDate` (14 digits). */
export const FIXED_PDF_DATE = '20000101000000';

const PDF_HEADER = '%PDF-';
const DATE_KEYS = ['/CreationDate', '/ModDate'] as const;

export interface NormalizeResult {
  /** Buffer to hand downstream — the normalised one, or the original on any failure. */
  buffer: Buffer;
  /** Number of date literals rewritten. */
  patched: number;
  /** Set when normalisation was skipped; the original buffer is returned. */
  reason?: string;
}

function isDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

function isWhitespace(byte: number): boolean {
  // PDF white-space: NUL, HT, LF, FF, CR, SP
  return byte === 0x00 || byte === 0x09 || byte === 0x0a
    || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

/**
 * Byte span of the document information dictionary object, resolved through
 * the `/Info N 0 R` reference. Returns null when the Info object is absent or
 * is not a plain top-level object (e.g. packed inside an object stream), in
 * which case the caller must leave the file alone.
 */
function findInfoObjectSpan(buf: Buffer): { start: number; end: number } | null {
  const text = buf.toString('latin1');

  // Last `/Info N 0 R` wins: with incremental updates the newest trailer is last.
  const infoRef = /\/Info\s+(\d+)\s+0\s+R/g;
  let objectNumber: string | null = null;
  for (let m = infoRef.exec(text); m !== null; m = infoRef.exec(text)) {
    objectNumber = m[1];
  }
  if (objectNumber === null) return null;

  // Matching `N 0 obj ... endobj`, again taking the last definition.
  const objDef = new RegExp(`(?:^|[\\s>])${objectNumber}\\s+0\\s+obj\\b`, 'g');
  let start = -1;
  for (let m = objDef.exec(text); m !== null; m = objDef.exec(text)) {
    start = m.index;
  }
  if (start < 0) return null;

  const end = text.indexOf('endobj', start);
  if (end < 0) return null;

  return { start, end };
}

/**
 * Offsets of the 14 date digits belonging to `/CreationDate` and `/ModDate`
 * keys at dictionary level inside the given span.
 *
 * The scan skips over literal `(...)` and hex `<...>` strings so a key-looking
 * sequence that happens to sit inside a user-controlled string value (a
 * `<title>` becomes `/Title`) can never be mistaken for a real key.
 */
function findDateDigitOffsets(buf: Buffer, start: number, end: number): number[] {
  const offsets: number[] = [];
  let i = start;

  while (i < end) {
    const byte = buf[i];

    // Literal string: honour backslash escapes and paren nesting.
    if (byte === 0x28 /* ( */) {
      let depth = 1;
      i += 1;
      while (i < end && depth > 0) {
        if (buf[i] === 0x5c /* \ */) i += 2;
        else if (buf[i] === 0x28) { depth += 1; i += 1; }
        else if (buf[i] === 0x29 /* ) */) { depth -= 1; i += 1; }
        else i += 1;
      }
      continue;
    }

    // Dictionary delimiters `<<` / `>>` are consumed before hex strings so a
    // dict opener is never mistaken for the start of a `<...>` hex string.
    if (byte === 0x3c /* < */ && buf[i + 1] === 0x3c) { i += 2; continue; }
    if (byte === 0x3e /* > */ && buf[i + 1] === 0x3e) { i += 2; continue; }

    // Hex string `<...>`.
    if (byte === 0x3c) {
      i += 1;
      while (i < end && buf[i] !== 0x3e /* > */) i += 1;
      i += 1;
      continue;
    }

    // Comment.
    if (byte === 0x25 /* % */) {
      while (i < end && buf[i] !== 0x0a && buf[i] !== 0x0d) i += 1;
      continue;
    }

    if (byte === 0x2f /* / */) {
      const key = DATE_KEYS.find((candidate) =>
        buf.toString('latin1', i, i + candidate.length) === candidate);
      if (!key) { i += 1; continue; }

      let j = i + key.length;
      // A name token must end at a delimiter, otherwise `/ModDateX` would match.
      if (j < end && !isWhitespace(buf[j]) && buf[j] !== 0x28 && buf[j] !== 0x2f) {
        i += 1;
        continue;
      }
      while (j < end && isWhitespace(buf[j])) j += 1;
      // Only plain `(D:YYYYMMDDHHmmSS…)` literals are rewritten; anything else
      // (hex string, indirect reference, unexpected shape) is left alone.
      if (buf.toString('latin1', j, j + 3) !== '(D:') { i += 1; continue; }
      const digitsAt = j + 3;
      let k = digitsAt;
      while (k < end && isDigit(buf[k])) k += 1;
      if (k - digitsAt !== 14) { i += 1; continue; }

      offsets.push(digitsAt);
      i = k;
      continue;
    }

    i += 1;
  }

  return offsets;
}

/**
 * Rewrite the wall-clock timestamps Chromium stamps into a PDF so that the
 * same rendered content always yields the same bytes.
 *
 * Never throws and never changes the length of the buffer. On any anomaly the
 * ORIGINAL buffer is returned so a generation can never fail because of
 * normalisation.
 */
export function normalizePdfBytes(input: Buffer): NormalizeResult {
  try {
    if (!Buffer.isBuffer(input) || input.length === 0) {
      return { buffer: input, patched: 0, reason: 'empty-buffer' };
    }
    if (input.toString('latin1', 0, PDF_HEADER.length) !== PDF_HEADER) {
      return { buffer: input, patched: 0, reason: 'not-a-pdf' };
    }

    const span = findInfoObjectSpan(input);
    if (!span) return { buffer: input, patched: 0, reason: 'info-object-not-found' };

    const offsets = findDateDigitOffsets(input, span.start, span.end);
    if (offsets.length === 0) {
      return { buffer: input, patched: 0, reason: 'no-date-literals' };
    }

    const out = Buffer.from(input);
    for (const offset of offsets) {
      out.write(FIXED_PDF_DATE, offset, 14, 'latin1');
    }

    // Belt and braces: prove that the only bytes that moved are the ones we
    // meant to move. Every stretch OUTSIDE the patched date literals must be
    // byte-identical to the input; anything else and we hand back the original.
    // (Segmented Buffer.compare — native, and subarray is zero-copy.)
    if (out.length !== input.length) {
      return { buffer: input, patched: 0, reason: 'length-changed' };
    }
    const sorted = [...offsets].sort((a, b) => a - b);
    let cursor = 0;
    for (const offset of sorted) {
      if (offset < cursor) {
        return { buffer: input, patched: 0, reason: 'overlapping-patch' };
      }
      if (Buffer.compare(out.subarray(cursor, offset), input.subarray(cursor, offset)) !== 0) {
        return { buffer: input, patched: 0, reason: 'unexpected-byte-changed' };
      }
      cursor = offset + 14;
    }
    if (Buffer.compare(out.subarray(cursor), input.subarray(cursor)) !== 0) {
      return { buffer: input, patched: 0, reason: 'unexpected-byte-changed' };
    }

    return { buffer: out, patched: offsets.length };
  } catch (err) {
    return {
      buffer: input,
      patched: 0,
      reason: `error:${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
