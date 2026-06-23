import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import puppeteer, { Browser } from 'puppeteer-core';
import Handlebars, { TemplateDelegate } from 'handlebars';
import { v4 as uuidv4 } from 'uuid';
import { Readable } from 'stream';
import { SESService } from './sesService';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { Theme } from '../theme/themeTypes';
import { buildThemeHead } from '../theme/buildThemeStyle';
import { FONT_FACE_CSS, DEFAULT_FONT_FACE_CSS } from '../theme/generated/fontFaces';
import { injectIntoHead } from '../theme/injectTheme';
import { buildSystemParams, SystemParams } from '../systemParams';
import qrcode from 'qrcode-generator';

const s3Client = new S3Client({});
const sesService = new SESService();
const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const MAX_CACHED_TEMPLATES = 100;
const MAX_CACHED_LOGOS = 100;

// Upper bound on how long we wait for webfonts to settle before printing.
// We no longer block on full network-idle (see generatePdfFromHtml); this cap
// keeps a slow/unreachable font CDN from stalling the whole render.
const FONT_WAIT_MS = 2000;

// Browser instance reuse - survives across warm Lambda invocations.
// browserLaunch guards against two concurrent renders each launching Chromium.
let browserInstance: Browser | null = null;
let browserLaunch: Promise<Browser> | null = null;

// Template compilation cache - avoids re-compiling same templates
const templateCache = new Map<string, TemplateDelegate>();

// Logo data-URI cache. logoKey embeds a unique id per upload, so a changed
// logo always yields a new key — caching by key is safe and skips the S3 GET
// + base64 encode on every branded render.
const logoCache = new Map<string, string>();

interface GeneratePdfOptions {
  userId: string;
  templateId: string;
  data: any;
  sendEmail?: string[];
}

interface PdfResult {
  url: string;
  key: string;
  sizeBytes: number;
}

interface ResolvedTheme {
  brand: string;
  accent: string;
  fontKey: string;
  logoDataUri: string | null;
}

// Register Handlebars helpers at module load so they are available even when
// PdfService is used statically (e.g. composeHtml in tests or other callers).
function registerHandlebarsHelpers(): void {
  Handlebars.registerHelper('ifEq', function (this: any, a: any, b: any, options: any) {
    if (a == b) return options.fn(this);
    else return options.inverse(this);
  });

  Handlebars.registerHelper('gt', function (a, b) {
    return (a > b);
  });

  Handlebars.registerHelper('formatDate', function (date: any) {
    // Simple date formatter
    const d = new Date(date);
    return d.toLocaleDateString();
  });

  Handlebars.registerHelper('formatCurrency', function (amount: number) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(amount);
  });

  // Inline self-hosted @font-face rules (woff2 data: URIs) so templates can
  // drop remote Google Fonts @import/<link> and render with zero network waits.
  // Usage: {{{mkpdfsFontFaces}}} (default inter-fraunces) or
  //        {{{mkpdfsFontFaces "inter-inter"}}}. Triple-stache: raw, unescaped.
  Handlebars.registerHelper('mkpdfsFontFaces', function (key: any) {
    const faces = (typeof key === 'string' && FONT_FACE_CSS[key]) || DEFAULT_FONT_FACE_CSS;
    return new Handlebars.SafeString(faces);
  });

  // Synchronous QR from a verify URL. Handlebars helpers can't await, so we use
  // qrcode-generator (sync) rather than the async `qrcode` package.
  // Usage: {{{mkpdfsQR verifyUrl}}} or {{{mkpdfsQR verifyUrl ec="H"}}}
  Handlebars.registerHelper('mkpdfsQR', function (url: any, options: any) {
    if (!url || typeof url !== 'string') return '';
    const ec = (options?.hash?.ec as string) || 'M';
    const qr = qrcode(0, ec as any); // 0 = auto-fit version
    qr.addData(url);
    qr.make();
    const svg = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    return new Handlebars.SafeString(svg);
  });

  Handlebars.registerHelper('mkpdfsLogo', function (this: any, name: any, options: any) {
    const theme = options?.data?.mkpdfsTheme as ResolvedTheme | undefined;
    if (theme && theme.logoDataUri) {
      return new Handlebars.SafeString(
        `<img class="brand-logo" src="${theme.logoDataUri}" alt="">`,
      );
    }
    const initial = (typeof name === 'string' && name.trim() ? name.trim()[0] : '') || '';
    return new Handlebars.SafeString(
      `<div class="brand-dot">${Handlebars.escapeExpression(initial)}</div>`,
    );
  });
}

registerHandlebarsHelpers();

export class PdfService {
  constructor() {
    // Helpers are registered at module load; constructor is a no-op here
    // but kept for backwards compatibility.
  }

  async generatePdf(options: GeneratePdfOptions): Promise<PdfResult> {
    const { userId, templateId, data, sendEmail } = options;

    // Read the template row (theme + content version) — falls through to
    // S3-only behaviour if the row is missing (legacy/direct uploads).
    const row = await this.getTemplateRow(userId, templateId);
    const contentVersion = row?.contentVersion || row?.updatedAt || 'v0';

    const [compiledTemplate, resolvedTheme] = await Promise.all([
      this.getCompiledTemplate(userId, templateId, contentVersion),
      this.resolveTheme(row?.theme as Theme | undefined),
    ]);
    const systemParams = buildSystemParams(new Date());

    const html = PdfService.composeHtml(compiledTemplate, data, resolvedTheme, systemParams);

    // Generate PDF
    const pdfBuffer = await this.generatePdfFromHtml(html);

    // Upload to S3
    const pdfId = uuidv4();
    const pdfKey = `${userId}/pdfs/${pdfId}.pdf`;

    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.ASSETS_BUCKET!,
      Key: pdfKey,
      Body: pdfBuffer,
      ContentType: 'application/pdf',
      Metadata: {
        userId,
        templateId,
        generatedAt: new Date().toISOString()
      }
    }));

    // Generate pre-signed URL (5 days expiry)
    const url = await getSignedUrl(s3Client, new GetObjectCommand({
      Bucket: process.env.ASSETS_BUCKET!,
      Key: pdfKey
    }), { expiresIn: 5 * 24 * 60 * 60 }); // 5 days

    // Send email if requested
    if (sendEmail && sendEmail.length > 0) {
      await sesService.sendPdfEmail({
        recipients: sendEmail,
        pdfBuffer,
        pdfUrl: url,
        fileName: `${templateId}_${new Date().toISOString().split('T')[0]}.pdf`
      });
    }

    return {
      url,
      key: pdfKey,
      sizeBytes: pdfBuffer.length
    };
  }

  /**
   * Render the compiled template with system params + theme, then inject the
   * theme <head> fragment. Pure string work — no browser, no I/O.
   */
  static composeHtml(
    compiled: TemplateDelegate,
    data: any,
    resolvedTheme: ResolvedTheme | undefined,
    systemParams: SystemParams,
  ): string {
    const runtime = resolvedTheme ? { data: { mkpdfsTheme: resolvedTheme } } : undefined;
    const renderOne = (item: any) =>
      compiled(typeof item === 'object' && item !== null ? { ...item, ...systemParams } : item, runtime);

    let html: string;
    if (Array.isArray(data)) {
      html = data.map(renderOne).join('<div style="page-break-after: always;"></div>');
    } else {
      html = renderOne(data);
    }

    if (resolvedTheme) {
      html = injectIntoHead(html, buildThemeHead(resolvedTheme));
    }
    return html;
  }

  /**
   * Wait for webfonts to finish loading, bounded by FONT_WAIT_MS. Templates
   * with no remote fonts resolve almost instantly; a slow/unreachable font CDN
   * can no longer stall the render past the cap.
   */
  private static async waitForFonts(page: import('puppeteer-core').Page): Promise<void> {
    await Promise.race([
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      page.evaluate(() => (globalThis as any).document?.fonts?.ready),
      new Promise((resolve) => setTimeout(resolve, FONT_WAIT_MS)),
    ]).catch(() => undefined);
  }

  private async generatePdfFromHtml(html: string): Promise<Buffer> {
    const browser = await this.getBrowser();

    const page = await browser.newPage();
    try {
      // 'load' (not 'networkidle0') — fire once the document + its referenced
      // resources are in, instead of waiting an extra 500ms quiet window for
      // the network to go fully idle. Fonts are then bounded by waitForFonts.
      await page.setContent(html, { waitUntil: 'load' });
      await page.emulateMediaType('screen');
      await PdfService.waitForFonts(page);

      const pdfBuffer = await page.pdf({
        format: 'A4',
        preferCSSPageSize: true,
        printBackground: true,
        margin: {
          top: '0',
          right: '0',
          bottom: '0',
          left: '0'
        }
      });

      return Buffer.from(pdfBuffer);
    } finally {
      await page.close(); // Close page, not browser (for reuse)
    }
  }

  /**
   * Generate a screenshot/thumbnail from HTML content.
   * Used for AI-generated template previews.
   */
  async generateScreenshot(html: string): Promise<Buffer> {
    const browser = await this.getBrowser();

    const page = await browser.newPage();
    try {
      // Set viewport to A4-like aspect ratio (800x1132 is roughly A4)
      await page.setViewport({ width: 800, height: 1132 });
      await page.setContent(html, { waitUntil: 'load' });
      await page.emulateMediaType('screen');
      await PdfService.waitForFonts(page);

      const screenshot = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width: 800, height: 1132 }
      });

      return Buffer.from(screenshot);
    } finally {
      await page.close();
    }
  }

  /**
   * Get or create a reusable browser instance.
   * Browser is reused across warm Lambda invocations for better performance.
   */
  private async getBrowser(): Promise<Browser> {
    // Check if existing browser is still connected
    if (browserInstance && browserInstance.isConnected()) {
      return browserInstance;
    }
    // Coalesce concurrent launches (e.g. two renders in one invocation) onto a
    // single in-flight promise so we never spawn two Chromium processes.
    if (browserLaunch) return browserLaunch;

    browserLaunch = (async () => {
      // Dynamic import for ESM compatibility
      const chromium = await import('@sparticuz/chromium');

      // Disable font hinting — it has no benefit for print rasterization and
      // shaves a little per-page layout time.
      const args = [...chromium.default.args];
      if (!args.includes('--font-render-hinting=none')) {
        args.push('--font-render-hinting=none');
      }

      const browser = await puppeteer.launch({
        args,
        executablePath: await chromium.default.executablePath(),
        headless: chromium.default.headless,
      });
      browserInstance = browser;
      return browser;
    })();

    try {
      return await browserLaunch;
    } finally {
      browserLaunch = null;
    }
  }

  private async streamToString(stream: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('error', (err) => reject(err));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
  }

  private async getTemplateRow(userId: string, templateId: string): Promise<any | undefined> {
    try {
      const res = await ddbDocClient.send(new GetCommand({
        TableName: process.env.TEMPLATES_TABLE!,
        Key: { userId, templateId },
      }));
      return res.Item;
    } catch (err) {
      console.error('[pdfService] failed to read template row:', err);
      return undefined; // render with defaults rather than fail the PDF
    }
  }

  /** Resolve a stored Theme into render-ready values (logo → data URI). */
  private async resolveTheme(theme?: Theme): Promise<ResolvedTheme | undefined> {
    if (!theme) return undefined;
    let logoDataUri: string | null = null;
    if (theme.logoKey) {
      const cached = logoCache.get(theme.logoKey);
      if (cached) {
        logoDataUri = cached;
      } else {
        try {
          const obj = await s3Client.send(new GetObjectCommand({
            Bucket: process.env.ASSETS_BUCKET!,
            Key: theme.logoKey,
          }));
          const bytes = await obj.Body!.transformToByteArray();
          const contentType = obj.ContentType || 'image/png';
          logoDataUri = `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`;
          logoCache.set(theme.logoKey, logoDataUri);
          // Bound the cache (LRU-ish: Map preserves insertion order)
          if (logoCache.size > MAX_CACHED_LOGOS) {
            const oldest = logoCache.keys().next().value;
            if (oldest) logoCache.delete(oldest);
          }
        } catch (err) {
          console.error('[pdfService] failed to load logo, falling back to mark:', err);
        }
      }
    }
    return { brand: theme.brand, accent: theme.accent, fontKey: theme.fontKey, logoDataUri };
  }

  /**
   * Get a compiled Handlebars template with caching.
   * Templates are cached by content version to avoid recompilation on updates.
   */
  private async getCompiledTemplate(
    userId: string,
    templateId: string,
    contentVersion: string,
  ): Promise<TemplateDelegate> {
    const cacheKey = `${userId}:${templateId}:${contentVersion}`;
    const cached = templateCache.get(cacheKey);
    if (cached) return cached;

    const templateKey = `${userId}/templates/${templateId}.hbs`;
    let templateContent: string;
    try {
      const templateResponse = await s3Client.send(new GetObjectCommand({
        Bucket: process.env.ASSETS_BUCKET!,
        Key: templateKey,
      }));
      templateContent = await this.streamToString(templateResponse.Body as Readable);
    } catch (error: any) {
      if (error.name === 'NoSuchKey') throw new Error(`Template not found: ${templateId}`);
      throw error;
    }

    const compiled = Handlebars.compile(templateContent);
    templateCache.set(cacheKey, compiled);
    // Bound the cache (LRU-ish: Map preserves insertion order)
    if (templateCache.size > MAX_CACHED_TEMPLATES) {
      const oldest = templateCache.keys().next().value;
      if (oldest) templateCache.delete(oldest);
    }
    return compiled;
  }

  /**
   * Invalidate a cached template (call after template updates).
   */
  static invalidateTemplateCache(userId: string, templateId: string): void {
    const prefix = `${userId}:${templateId}:`;
    for (const key of templateCache.keys()) {
      if (key.startsWith(prefix)) templateCache.delete(key);
    }
  }

  /**
   * Clear all cached templates.
   */
  static clearTemplateCache(): void {
    templateCache.clear();
  }
}
