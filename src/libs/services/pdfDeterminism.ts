/**
 * Byte-level determinism for Chromium/Skia PDFs.
 *
 * THE CONTRACT (read this before touching anything below)
 * -------------------------------------------------------
 * This module does NOT "make arbitrary PDFs deterministic". It normalises the
 * two wall-clock timestamps in the output of ONE known producer:
 *
 *   > the PDF bytes just returned by `page.pdf()` from the approved Chromium /
 *   > Skia layer, BEFORE any signing, encryption, linearisation, incremental
 *   > update or other post-processing.
 *
 * Anything else — a signed file, an encrypted file, a file with incremental
 * updates, a file carrying XMP metadata, a file whose `/Info` dictionary does
 * not look exactly like Skia's — is OUT OF CONTRACT. Out of contract is not a
 * silent best-effort case: it is a contract failure. The original buffer is
 * returned untouched together with a specific `reason`, and the caller logs it.
 *
 * That narrowing is deliberate. Patching bytes of an already-signed document
 * invalidates the signature; patching bytes of a revision that an incremental
 * update supersedes corrupts the semantics of the file even though it still
 * opens; and patching a date the file also carries in XMP leaves the two copies
 * disagreeing. None of those are things we can do safely from the outside, so
 * we refuse instead.
 *
 * WHAT SKIA ACTUALLY EMITS
 * ------------------------
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
 * Overwrite the date literal in place with a fixed constant of exactly the same
 * byte length, so every cross-reference offset in the file stays valid and
 * every other byte is preserved bit for bit. That makes the "rendered content
 * is unchanged" claim provable rather than merely tested: the output differs
 * from the input only inside two metadata date literals.
 *
 * A full re-serialisation (pdf-lib load + save) was deliberately rejected: it
 * rewrites the entire document — every object, stream and offset — on PDFs
 * built from arbitrary customer HTML, for no gain over a ~28-byte edit.
 *
 * `/Producer` is intentionally NOT normalised. It carries the Chromium
 * milestone, so a renderer upgrade changes the hash — which is exactly what a
 * downstream byte-comparison verifier should notice, because the raster can
 * change with it.
 *
 * FOLLOW-UP (not implemented on purpose — product decision pending)
 * ----------------------------------------------------------------
 * Piggy-backing renderer identity on `/Producer` is a coarse signal: it
 * invalidates every stored hash globally the moment the Chromium milestone
 * moves even when the render is byte-identical, and conversely it does NOT
 * distinguish two different builds inside the same milestone. The cleaner shape
 * is to split the two concerns and expose them separately — an `artifact_sha256`
 * over fully normalised bytes (dates AND `/Producer`) plus an explicit
 * `renderer_fingerprint` recorded next to it. Deliberately left undone here;
 * changing the identity model is the product owner's call, not this module's.
 *
 * SAFETY
 * ------
 * Every failure mode returns the original buffer untouched. This never throws.
 */

/** Fixed timestamp stamped into `/CreationDate` and `/ModDate` (14 digits). */
export const FIXED_PDF_DATE = '20000101000000';

const PDF_HEADER = '%PDF-';
const CREATION_DATE = '/CreationDate';
const MOD_DATE = '/ModDate';
const DATE_KEYS = [CREATION_DATE, MOD_DATE] as const;

/** Exactly the two direct `/Info` entries this module is allowed to rewrite. */
const EXPECTED_PATCHES = 2;

export interface NormalizeResult {
  /** Buffer to hand downstream — the normalised one, or the original on any failure. */
  buffer: Buffer;
  /** Number of date literals rewritten. Always 0 or `EXPECTED_PATCHES`. */
  patched: number;
  /** Set when normalisation was skipped; the original buffer is returned. */
  reason?: string;
}

interface Patch {
  /** Offset of the first byte to overwrite (the `D` of `D:` is NOT included). */
  offset: number;
  /** Replacement text; `replacement.length` always equals the span it replaces. */
  replacement: string;
}

function isDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

function isWhitespace(byte: number): boolean {
  // PDF white-space: NUL, HT, LF, FF, CR, SP
  return byte === 0x00 || byte === 0x09 || byte === 0x0a
    || byte === 0x0c || byte === 0x0d || byte === 0x20;
}

/** PDF delimiters: `( ) < > [ ] { } / %`. */
function isDelimiter(byte: number): boolean {
  return byte === 0x28 || byte === 0x29 || byte === 0x3c || byte === 0x3e
    || byte === 0x5b || byte === 0x5d || byte === 0x7b || byte === 0x7d
    || byte === 0x2f || byte === 0x25;
}

/** A name token ends at white-space, a delimiter or EOF — never mid-word. */
function isNameBoundary(buf: Buffer, index: number): boolean {
  if (index >= buf.length) return true;
  return isWhitespace(buf[index]) || isDelimiter(buf[index]);
}

/**
 * Occurrences of a complete PDF name token (`/Sig` must not match
 * `/Signature`). `/` is itself a delimiter, so any occurrence starts a name.
 */
function findNameTokens(buf: Buffer, text: string, name: string): number[] {
  const hits: number[] = [];
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
    if (isNameBoundary(buf, at + name.length)) hits.push(at);
  }
  return hits;
}

function findOccurrences(text: string, needle: string): number[] {
  const hits: number[] = [];
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) hits.push(at);
  return hits;
}

/** Encryption / signature markers that must not appear as a real name token. */
const ENCRYPTION_MARKERS = ['/Encrypt'] as const;
const SIGNATURE_MARKERS = ['/ByteRange', '/Sig', '/SigFlags', '/DocMDP'] as const;
const XMP_MARKERS = ['/Metadata'] as const;

/**
 * Structures this module refuses to touch, checked before anything is rewritten.
 *
 * Each of these means the file is not "raw output of the approved Chromium
 * layer" any more, and an in-place byte edit would be unsound rather than
 * merely useless.
 *
 * `outside` skips hits inside the Info object, whose values are customer text
 * (a `<title>` of `foo/Sig` must not be read as a signature). The Info object
 * is parsed key by key further down, and its real keys are checked there.
 */
function detectOutOfContractStructure(
  buf: Buffer, text: string, outside: (index: number) => boolean,
): string | null {
  // Encrypted: strings/streams are ciphertext, and the Info dates are encrypted
  // too — patching plaintext digits into them corrupts the document.
  for (const marker of ENCRYPTION_MARKERS) {
    if (findNameTokens(buf, text, marker).some(outside)) return 'encrypted';
  }

  // Digitally signed: the signature covers a byte range of this very file.
  // Rewriting any byte inside it invalidates the signature.
  for (const marker of SIGNATURE_MARKERS) {
    if (findNameTokens(buf, text, marker).some(outside)) return 'digitally-signed';
  }

  // Incremental updates: the file holds several revisions appended to each
  // other. Bytes of an older revision are still referenced by that revision's
  // xref; editing them damages the semantics even though the file still opens.
  if (findOccurrences(text, 'startxref').filter(outside).length > 1) return 'incremental-update';
  if (findOccurrences(text, '%%EOF').filter(outside).length > 1) return 'incremental-update';

  // XMP metadata carries its own copy of the creation/modification dates. It is
  // frequently Flate-compressed, so we cannot even tell whether it holds dates —
  // and if it does, patching only the Info dict leaves the two disagreeing while
  // the hash stays non-deterministic. Skia emits no `/Metadata` at all, so the
  // mere presence of the key means we are outside the contract.
  for (const marker of XMP_MARKERS) {
    if (findNameTokens(buf, text, marker).some(outside)) return 'xmp-metadata';
  }

  return null;
}

interface InfoObject {
  /** Offset of the `N 0 obj` token. */
  objStart: number;
  /** Offset just after the `obj` keyword — where the dictionary must begin. */
  bodyStart: number;
  /** Offset of the `endobj` keyword. */
  objEnd: number;
}

/**
 * The document information dictionary object, resolved through `/Info N 0 R`.
 *
 * Fails closed when the reference is missing, when different references
 * disagree, when the object is not a plain top-level object (e.g. packed inside
 * an object stream) or when the file defines it more than once.
 */
function locateInfoObject(text: string): InfoObject | string {
  const infoRef = /\/Info\s+(\d+)\s+0\s+R/g;
  const objectNumbers = new Set<string>();
  for (let m = infoRef.exec(text); m !== null; m = infoRef.exec(text)) {
    objectNumbers.add(m[1]);
  }
  if (objectNumbers.size === 0) return 'info-object-not-found';
  if (objectNumbers.size > 1) return 'info-reference-ambiguous';

  const objectNumber = [...objectNumbers][0];
  const objDef = new RegExp(`(?:^|[\\s>])(${objectNumber}\\s+0\\s+obj)(?![0-9A-Za-z])`, 'g');
  const definitions: InfoObject[] = [];
  for (let m = objDef.exec(text); m !== null; m = objDef.exec(text)) {
    const objStart = m.index + (m[0].length - m[1].length);
    const bodyStart = objStart + m[1].length;
    const objEnd = text.indexOf('endobj', bodyStart);
    if (objEnd < 0) return 'info-object-unterminated';
    definitions.push({ objStart, bodyStart, objEnd });
  }
  if (definitions.length === 0) return 'info-object-not-found';
  if (definitions.length > 1) return 'info-object-ambiguous';

  return definitions[0];
}

interface DictEntry {
  key: string;
  /** 1 for a direct entry of the Info dictionary, >1 for anything nested. */
  depth: number;
  /** Offset of the first byte of the value token. */
  valueStart: number;
  /** Offset just past the last byte of the value token. */
  valueEnd: number;
}

function skipTrivia(buf: Buffer, index: number, end: number): number {
  let i = index;
  while (i < end) {
    if (isWhitespace(buf[i])) { i += 1; continue; }
    if (buf[i] === 0x25 /* % */) {
      while (i < end && buf[i] !== 0x0a && buf[i] !== 0x0d) i += 1;
      continue;
    }
    break;
  }
  return i;
}

/** End offset of a literal `(...)` string starting at `index`, or -1. */
function scanLiteralString(buf: Buffer, index: number, end: number): number {
  let i = index + 1;
  let depth = 1;
  while (i < end && depth > 0) {
    const byte = buf[i];
    if (byte === 0x5c /* \ */) { i += 2; continue; }
    if (byte === 0x28 /* ( */) { depth += 1; i += 1; continue; }
    if (byte === 0x29 /* ) */) { depth -= 1; i += 1; continue; }
    i += 1;
  }
  return depth === 0 ? i : -1;
}

/**
 * End offset of any single PDF value token starting at `index`, or -1 when the
 * bytes are not a value this parser understands. Nested dictionaries are parsed
 * recursively so their keys land in `entries` too.
 */
function scanValue(
  buf: Buffer, index: number, end: number, depth: number, entries: DictEntry[],
): number {
  if (index >= end) return -1;
  const byte = buf[index];

  if (byte === 0x28 /* ( */) return scanLiteralString(buf, index, end);

  if (byte === 0x3c /* < */) {
    if (buf[index + 1] === 0x3c) return scanDictionary(buf, index, end, depth, entries);
    let i = index + 1;
    while (i < end && buf[i] !== 0x3e /* > */) i += 1;
    return i < end ? i + 1 : -1;
  }

  if (byte === 0x5b /* [ */) {
    let i = index + 1;
    for (;;) {
      i = skipTrivia(buf, i, end);
      if (i >= end) return -1;
      if (buf[i] === 0x5d /* ] */) return i + 1;
      const next = scanValue(buf, i, end, depth, entries);
      if (next < 0) return -1;
      i = next;
    }
  }

  if (byte === 0x2f /* / */) {
    let i = index + 1;
    while (i < end && !isNameBoundary(buf, i)) i += 1;
    return i;
  }

  for (const literal of ['true', 'false', 'null']) {
    if (buf.toString('latin1', index, index + literal.length) === literal
      && isNameBoundary(buf, index + literal.length)) {
      return index + literal.length;
    }
  }

  if (isDigit(byte) || byte === 0x2b /* + */ || byte === 0x2d /* - */ || byte === 0x2e /* . */) {
    let i = index;
    while (i < end && (isDigit(buf[i]) || buf[i] === 0x2b || buf[i] === 0x2d || buf[i] === 0x2e)) i += 1;
    // `N G R` indirect reference: only when the whole triple is present.
    const numeric = buf.toString('latin1', index, i);
    if (/^\d+$/.test(numeric)) {
      let j = skipTrivia(buf, i, end);
      const genStart = j;
      while (j < end && isDigit(buf[j])) j += 1;
      if (j > genStart) {
        const k = skipTrivia(buf, j, end);
        if (buf[k] === 0x52 /* R */ && isNameBoundary(buf, k + 1)) return k + 1;
      }
    }
    return i;
  }

  return -1;
}

/**
 * Parse a `<<...>>` dictionary starting at `index`, appending every key it
 * contains (at this level and below) to `entries`. Returns the offset just past
 * the closing `>>`, or -1 when the bytes are not a well-formed dictionary.
 *
 * Alternating key/value parsing is what makes depth tracking trustworthy: a
 * `/CreationDate` sitting in a VALUE position, inside a nested dictionary, or
 * inside a string can never be mistaken for a direct key of this dictionary.
 */
function scanDictionary(
  buf: Buffer, index: number, end: number, depth: number, entries: DictEntry[],
): number {
  if (buf[index] !== 0x3c || buf[index + 1] !== 0x3c) return -1;
  let i = index + 2;

  for (;;) {
    i = skipTrivia(buf, i, end);
    if (i >= end) return -1;
    if (buf[i] === 0x3e /* > */ && buf[i + 1] === 0x3e) return i + 2;

    if (buf[i] !== 0x2f /* / */) return -1;
    const keyStart = i;
    i += 1;
    while (i < end && !isNameBoundary(buf, i)) i += 1;
    const key = buf.toString('latin1', keyStart, i);

    i = skipTrivia(buf, i, end);
    const valueStart = i;
    const valueEnd = scanValue(buf, i, end, depth + 1, entries);
    if (valueEnd < 0) return -1;

    entries.push({ key, depth, valueStart, valueEnd });
    i = valueEnd;
  }
}

/**
 * Every key of the Info object, with its nesting depth. `null` when the object
 * is not exactly `N 0 obj <<...>> endobj` — in which case we must not touch it.
 */
function parseInfoDictionary(buf: Buffer, info: InfoObject): DictEntry[] | null {
  const entries: DictEntry[] = [];
  const dictStart = skipTrivia(buf, info.bodyStart, info.objEnd);
  const dictEnd = scanDictionary(buf, dictStart, info.objEnd, 1, entries);
  if (dictEnd < 0) return null;
  // Nothing but white-space is allowed between `>>` and `endobj`.
  if (skipTrivia(buf, dictEnd, info.objEnd) !== info.objEnd) return null;
  return entries;
}

/**
 * Time-zone suffixes we recognise, and the UTC-equivalent replacement for each.
 *
 * The replacement is ALWAYS the same byte length as what it replaces — that is
 * the invariant that keeps every xref offset in the file valid. A suffix shape
 * that is not in this table is a contract failure, not something to leave as-is:
 * an un-normalised suffix would silently vary with the host's time zone and
 * defeat the whole point.
 */
const TIMEZONE_SUFFIXES: Array<{ pattern: RegExp; canonical: string }> = [
  { pattern: /^$/, canonical: '' },
  { pattern: /^Z$/, canonical: 'Z' },
  { pattern: /^Z00'00'$/, canonical: "Z00'00'" },
  { pattern: /^Z00'00$/, canonical: "Z00'00" },
  { pattern: /^[+-]\d{2}'\d{2}'$/, canonical: "+00'00'" },
  { pattern: /^[+-]\d{2}'\d{2}$/, canonical: "+00'00" },
  { pattern: /^[+-]\d{2}'$/, canonical: "+00'" },
  { pattern: /^[+-]\d{2}$/, canonical: '+00' },
];

/** `D:YYYYMMDDHHmmSS` with plausible field values — form only, no calendar maths. */
function isPlausibleStamp(digits: string): boolean {
  if (!/^\d{14}$/.test(digits)) return false;
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const hour = Number(digits.slice(8, 10));
  const minute = Number(digits.slice(10, 12));
  const second = Number(digits.slice(12, 14));
  return month >= 1 && month <= 12
    && day >= 1 && day <= 31
    && hour <= 23
    && minute <= 59
    && second <= 60; // leap second tolerated
}

/**
 * Turn a `/CreationDate` or `/ModDate` value into the patch that normalises it.
 *
 * The value must be a literal string of the complete form
 * `(D:YYYYMMDDHHmmSS<tz>)` — full 14-digit stamp, a recognised time-zone
 * suffix, and a closing parenthesis immediately after it. A truncated stamp, a
 * trailing comment inside the literal, an unknown suffix or a missing `)` all
 * return `null`, which the caller turns into a contract failure.
 */
function buildDatePatch(buf: Buffer, entry: DictEntry): Patch | null {
  if (buf[entry.valueStart] !== 0x28 /* ( */) return null;
  // valueEnd points past the closing `)`.
  const closing = entry.valueEnd - 1;
  if (buf[closing] !== 0x29 /* ) */) return null;

  const body = buf.toString('latin1', entry.valueStart + 1, closing);
  if (!body.startsWith('D:')) return null;

  const digits = body.slice(2, 16);
  if (!isPlausibleStamp(digits)) return null;

  const suffix = body.slice(16);
  const rule = TIMEZONE_SUFFIXES.find((candidate) => candidate.pattern.test(suffix));
  if (!rule) return null;
  if (rule.canonical.length !== suffix.length) return null; // defensive: length is the invariant

  return {
    offset: entry.valueStart + 1 + 2, // just past `(D:`
    replacement: FIXED_PDF_DATE + rule.canonical,
  };
}

/**
 * Rewrite the wall-clock timestamps Chromium stamps into a PDF so that the same
 * rendered content always yields the same bytes.
 *
 * Never throws and never changes the length of the buffer. On ANY deviation
 * from the contract documented at the top of this file the ORIGINAL buffer is
 * returned with a specific `reason`, so a generation can never fail because of
 * normalisation — but it can never silently half-normalise either.
 */
export function normalizePdfBytes(input: Buffer): NormalizeResult {
  const bail = (reason: string): NormalizeResult => ({ buffer: input, patched: 0, reason });

  try {
    if (!Buffer.isBuffer(input) || input.length === 0) return bail('empty-buffer');
    if (input.toString('latin1', 0, PDF_HEADER.length) !== PDF_HEADER) return bail('not-a-pdf');

    const text = input.toString('latin1');

    const info = locateInfoObject(text);
    if (typeof info === 'string') return bail(info);

    const outsideInfo = (at: number) => at < info.objStart || at >= info.objEnd;
    const outOfContract = detectOutOfContractStructure(input, text, outsideInfo);
    if (outOfContract) return bail(outOfContract);

    // No date key may live anywhere but inside the Info object: a second,
    // un-normalised copy elsewhere would keep the bytes non-deterministic.
    for (const key of DATE_KEYS) {
      if (findNameTokens(input, text, key).some(outsideInfo)) return bail('date-key-outside-info');
    }

    const entries = parseInfoDictionary(input, info);
    if (entries === null) return bail('info-dictionary-unparsable');

    // The Info object's own keys were excluded from the structural scan above
    // (they sit inside customer-controlled text), so check the parsed keys here.
    const forbiddenKeys = new Set<string>([
      ...ENCRYPTION_MARKERS, ...SIGNATURE_MARKERS, ...XMP_MARKERS,
    ]);
    if (entries.some((entry) => forbiddenKeys.has(entry.key))) {
      return bail('out-of-contract-key-in-info');
    }

    // Date keys must be DIRECT entries of the Info dictionary. One nested in a
    // sub-dictionary is a shape we have never seen from Skia and cannot vouch
    // for, so it fails the contract instead of being patched blindly.
    if (entries.some((entry) => entry.depth > 1 && (DATE_KEYS as readonly string[]).includes(entry.key))) {
      return bail('date-key-nested');
    }

    const patches: Patch[] = [];
    for (const key of DATE_KEYS) {
      const matches = entries.filter((entry) => entry.depth === 1 && entry.key === key);
      // Exactly one each: zero means there is nothing we are allowed to assume,
      // two means a malformed dictionary where the reader's pick is unspecified.
      if (matches.length !== 1) return bail(`info-date-not-unique:${key.slice(1)}:${matches.length}`);
      const patch = buildDatePatch(input, matches[0]);
      if (patch === null) return bail(`date-literal-out-of-contract:${key.slice(1)}`);
      patches.push(patch);
    }

    // The whole point of the contract: exactly the two Info dates, no more, no
    // fewer. Anything else is a failure, never a quiet partial normalisation.
    if (patches.length !== EXPECTED_PATCHES) {
      return bail(`contract-violation:expected-${EXPECTED_PATCHES}-patches-got-${patches.length}`);
    }

    const out = Buffer.from(input);
    for (const patch of patches) {
      const written = out.write(patch.replacement, patch.offset, patch.replacement.length, 'latin1');
      if (written !== patch.replacement.length) return bail('patch-truncated');
    }

    // Belt and braces: prove that the only bytes that moved are the ones we
    // meant to move. Every stretch OUTSIDE the patched date literals must be
    // byte-identical to the input; anything else and we hand back the original.
    // (Segmented Buffer.compare — native, and subarray is zero-copy.)
    if (out.length !== input.length) return bail('length-changed');

    const sorted = [...patches].sort((a, b) => a.offset - b.offset);
    let cursor = 0;
    for (const patch of sorted) {
      if (patch.offset < cursor) return bail('overlapping-patch');
      if (Buffer.compare(out.subarray(cursor, patch.offset), input.subarray(cursor, patch.offset)) !== 0) {
        return bail('unexpected-byte-changed');
      }
      cursor = patch.offset + patch.replacement.length;
    }
    if (Buffer.compare(out.subarray(cursor), input.subarray(cursor)) !== 0) {
      return bail('unexpected-byte-changed');
    }

    return { buffer: out, patched: patches.length };
  } catch (err) {
    return bail(`error:${err instanceof Error ? err.message : String(err)}`);
  }
}
