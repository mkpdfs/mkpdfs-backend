import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import puppeteer, { Browser } from 'puppeteer-core';
import Handlebars, { TemplateDelegate } from 'handlebars';
import { v4 as uuidv4 } from 'uuid';
import { Readable } from 'stream';
import { SESService } from './sesService';

const s3Client = new S3Client({});
const sesService = new SESService();

// Browser instance reuse - survives across warm Lambda invocations
let browserInstance: Browser | null = null;

// Template compilation cache - avoids re-compiling same templates
const templateCache = new Map<string, { compiled: TemplateDelegate; timestamp: number }>();
const TEMPLATE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes TTL to handle template updates

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

export class PdfService {
  constructor() {
    this.registerHandlebarsHelpers();
  }

  private registerHandlebarsHelpers(): void {
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
  }

  async generatePdf(options: GeneratePdfOptions): Promise<PdfResult> {
    const { userId, templateId, data, sendEmail } = options;

    // Get compiled template (with caching)
    const compiledTemplate = await this.getCompiledTemplate(userId, templateId);
    let html: string;

    // Handle array data for batch processing
    if (Array.isArray(data)) {
      const htmlPages = data.map(item => compiledTemplate(item));
      html = htmlPages.join('<div style="page-break-after: always;"></div>');
    } else {
      html = compiledTemplate(data);
    }

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

  private async generatePdfFromHtml(html: string): Promise<Buffer> {
    const browser = await this.getBrowser();

    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'networkidle0' });
      await page.emulateMediaType('screen');

      const pdfBuffer = await page.pdf({
        format: 'A4',
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
      await page.setContent(html, { waitUntil: 'networkidle0' });
      await page.emulateMediaType('screen');

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

    // Dynamic import for ESM compatibility
    const chromium = await import('@sparticuz/chromium');

    browserInstance = await puppeteer.launch({
      args: chromium.default.args,
      executablePath: await chromium.default.executablePath(),
      headless: chromium.default.headless
    });

    return browserInstance;
  }

  private async streamToString(stream: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    return new Promise((resolve, reject) => {
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('error', (err) => reject(err));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
  }

  /**
   * Get a compiled Handlebars template with caching.
   * Templates are cached with a TTL to handle updates while avoiding recompilation.
   */
  private async getCompiledTemplate(userId: string, templateId: string): Promise<TemplateDelegate> {
    const cacheKey = `${userId}:${templateId}`;
    const now = Date.now();

    // Check cache and TTL
    const cached = templateCache.get(cacheKey);
    if (cached && (now - cached.timestamp) < TEMPLATE_CACHE_TTL) {
      return cached.compiled;
    }

    // Fetch template from S3
    const templateKey = `${userId}/templates/${templateId}.hbs`;
    const templateCommand = new GetObjectCommand({
      Bucket: process.env.ASSETS_BUCKET!,
      Key: templateKey
    });

    let templateContent: string;
    try {
      const templateResponse = await s3Client.send(templateCommand);
      templateContent = await this.streamToString(templateResponse.Body as Readable);
    } catch (error: any) {
      if (error.name === 'NoSuchKey') {
        throw new Error(`Template not found: ${templateId}`);
      }
      throw error;
    }

    // Compile and cache
    const compiled = Handlebars.compile(templateContent);
    templateCache.set(cacheKey, { compiled, timestamp: now });

    return compiled;
  }

  /**
   * Invalidate a cached template (call after template updates).
   */
  static invalidateTemplateCache(userId: string, templateId: string): void {
    const cacheKey = `${userId}:${templateId}`;
    templateCache.delete(cacheKey);
  }

  /**
   * Clear all cached templates.
   */
  static clearTemplateCache(): void {
    templateCache.clear();
  }
}
