export class LogoIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogoIngestError';
  }
}

export const MAX_LOGO_BYTES = 512 * 1024; // 512 KB cap (data-URI inlined at render)

const CONTENT_TYPE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

export function extFromContentType(contentType: string): string {
  const ct = contentType.split(';')[0].trim().toLowerCase();
  const ext = CONTENT_TYPE_EXT[ct];
  if (!ext) throw new LogoIngestError(`Unsupported logo content type: ${ct}`);
  return ext;
}

/** Block obviously-internal hosts. Defense in depth (Lambda has no VPC route to metadata, but be strict). */
export function assertSafeLogoUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LogoIngestError('Invalid logo URL');
  }
  if (url.protocol !== 'https:') throw new LogoIngestError('Logo URL must be https');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^fe80:/i.test(host) ||
    /^fc00:/i.test(host) ||
    /^fd[0-9a-f]{2}:/i.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
  ) {
    throw new LogoIngestError('Logo URL host is not allowed');
  }
  return url;
}

export interface IngestedLogo {
  buffer: Buffer;
  contentType: string;
  ext: string;
}

/** Fetch + validate a remote logo. HTTPS only, public host, size & type capped. */
export async function fetchLogoFromUrl(raw: string): Promise<IngestedLogo> {
  assertSafeLogoUrl(raw);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(raw, { redirect: 'error', signal: controller.signal });
    if (!res.ok) throw new LogoIngestError(`Logo fetch failed: HTTP ${res.status}`);
    const contentType = res.headers.get('content-type') || '';
    const ext = extFromContentType(contentType);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new LogoIngestError('Logo is empty');
    if (buf.length > MAX_LOGO_BYTES) {
      throw new LogoIngestError(`Logo exceeds ${MAX_LOGO_BYTES} bytes`);
    }
    return { buffer: buf, contentType: contentType.split(';')[0].trim().toLowerCase(), ext };
  } catch (err) {
    if (err instanceof LogoIngestError) throw err;
    throw new LogoIngestError(`Logo fetch failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }
}
