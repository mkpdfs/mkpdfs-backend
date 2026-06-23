/**
 * Marketplace Thumbnail Generator
 *
 * Renders each marketplace template (.hbs + its sampleDataJson) to a single
 * A4-page PNG, matching how the real PDF generator renders (portrait A4,
 * margin 0, identical Handlebars helpers). Optionally uploads to S3.
 *
 * Usage:
 *   AWS_PROFILE=rocketeast npx ts-node scripts/generate-thumbnails.ts <stage> [--only=<templateId>] [--upload]
 *
 * Examples:
 *   npx ts-node scripts/generate-thumbnails.ts dev --only=mp-business-invoice
 *   AWS_PROFILE=rocketeast npx ts-node scripts/generate-thumbnails.ts dev --upload
 *
 * Chrome: uses CHROME_PATH env or the default macOS Google Chrome path.
 */

import * as fs from 'fs';
import * as path from 'path';
import Handlebars from 'handlebars';
import { FONT_FACE_CSS, DEFAULT_FONT_FACE_CSS } from '../src/libs/theme/generated/fontFaces';
import puppeteer from 'puppeteer-core';
import qrcode from 'qrcode-generator';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { templates } from './seed-marketplace';

const stage = process.argv[2] || 'dev';
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.split('=')[1] : null;
const doUpload = process.argv.includes('--upload');

const region = 'us-east-1';
const ASSETS_BUCKET = `mkpdfs-${stage}-bucket`;
const TEMPLATES_DIR = path.join(__dirname, 'marketplace-templates');
const OUTPUT_DIR = path.join(__dirname, 'marketplace-thumbnails');

const CHROME_PATH =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// A4 at 96dpi
const A4_W = 794;
const A4_H = 1123;
// A4 landscape at 96dpi
const A4_LAND_W = 1123;
const A4_LAND_H = 794;

const s3Client = new S3Client({ region });

// --- Handlebars helpers: MUST stay identical to src/libs/services/pdfService.ts ---
Handlebars.registerHelper('ifEq', function (this: any, a: any, b: any, options: any) {
  if (a == b) return options.fn(this);
  else return options.inverse(this);
});
Handlebars.registerHelper('gt', function (a: number, b: number) {
  return a > b;
});
Handlebars.registerHelper('formatDate', function (date: any) {
  const d = new Date(date);
  return d.toLocaleDateString();
});
Handlebars.registerHelper('formatCurrency', function (amount: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
});
Handlebars.registerHelper('mkpdfsFontFaces', function (key: any) {
  const faces = (typeof key === 'string' && FONT_FACE_CSS[key]) || DEFAULT_FONT_FACE_CSS;
  return new Handlebars.SafeString(faces);
});
Handlebars.registerHelper('mkpdfsQR', function (url: any, options: any) {
  if (!url || typeof url !== 'string') return '';
  const ec = (options?.hash?.ec as string) || 'M';
  const qr = qrcode(0, ec as any);
  qr.addData(url);
  qr.make();
  return new Handlebars.SafeString(qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true }));
});

async function main() {
  if (!fs.existsSync(CHROME_PATH)) {
    console.error(`Chrome not found at ${CHROME_PATH}. Set CHROME_PATH env var.`);
    process.exit(1);
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const list = only ? templates.filter((t) => t.templateId === only) : templates;
  if (list.length === 0) {
    console.error(`No templates matched${only ? ` --only=${only}` : ''}.`);
    process.exit(1);
  }

  console.log(`Rendering ${list.length} template(s) for ${stage}${doUpload ? ' (will upload)' : ' (local only)'}...`);
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    for (const t of list) {
      const filePath = path.join(TEMPLATES_DIR, `${t.templateId}.hbs`);
      if (!fs.existsSync(filePath)) {
        console.log(`  ⚠️  missing .hbs: ${t.templateId}`);
        continue;
      }
      const data = JSON.parse(t.sampleDataJson);
      const html = Handlebars.compile(fs.readFileSync(filePath, 'utf-8'))(data);

      const landscape = t.orientation === 'landscape';
      const W = landscape ? A4_LAND_W : A4_W;
      const H = landscape ? A4_LAND_H : A4_H;

      const page = await browser.newPage();
      await page.setViewport({ width: W, height: H, deviceScaleFactor: 2 });
      await page.setContent(html, { waitUntil: 'load' });
      await page.evaluate(async () => {
        await (document as any).fonts.ready;
      });

      const outPath = path.join(OUTPUT_DIR, `${t.templateId}.png`);
      const shot = Buffer.from(
        await page.screenshot({
          type: 'png',
          clip: { x: 0, y: 0, width: W, height: H },
        })
      );
      fs.writeFileSync(outPath, shot);
      await page.close();
      console.log(`  ✓ rendered ${t.templateId}.png`);

      if (doUpload) {
        await s3Client.send(
          new PutObjectCommand({
            Bucket: ASSETS_BUCKET,
            Key: `marketplace/thumbnails/${t.templateId}.png`,
            Body: shot,
            ContentType: 'image/png',
            CacheControl: 'public, max-age=300',
          })
        );
        console.log(`    ↑ uploaded to s3://${ASSETS_BUCKET}/marketplace/thumbnails/${t.templateId}.png`);
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`\nDone. PNGs in ${OUTPUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
