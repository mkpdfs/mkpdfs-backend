import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import puppeteer, { Browser } from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import Handlebars from 'handlebars';
import { v4 as uuidv4 } from 'uuid';
import { Readable } from 'stream';
import { SESService } from './sesService';

const s3Client = new S3Client({});
const sesService = new SESService();

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
    
    // Get template from S3
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
    
    // Compile template with data
    const compiledTemplate = Handlebars.compile(templateContent);
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
    // Always use @sparticuz/chromium for consistent behavior across environments
    const browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });
    
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      await page.emulateMediaType('screen');
      
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: {
          top: '10mm',
          right: '10mm',
          bottom: '10mm',
          left: '10mm'
        }
      });
      
      return Buffer.from(pdfBuffer);
    } finally {
      await browser.close();
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
}