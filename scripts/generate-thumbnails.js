/**
 * Marketplace Thumbnail Generator
 *
 * Generates thumbnail images from marketplace templates using Puppeteer.
 *
 * Prerequisites:
 *   npm install handlebars puppeteer
 *
 * Usage:
 *   1. Download templates: aws s3 sync s3://mkpdfs-{stage}-bucket/marketplace/templates/ ./templates/
 *   2. Get sample data: aws dynamodb scan --table-name mkpdfs-{stage}-marketplace > sample_data.json
 *   3. Parse sample data: node -e "..." (see below)
 *   4. Run this script: node generate-thumbnails.js
 *   5. Upload results to S3
 *
 * Outputs:
 *   - output/          - Cropped thumbnails (800x600, top portion)
 *   - output-full/     - Full page thumbnails
 */

const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');
const puppeteer = require('puppeteer');

// Register common Handlebars helpers used in templates
Handlebars.registerHelper('multiply', (a, b) => a * b);
Handlebars.registerHelper('formatCurrency', (amount) => `$${Number(amount).toFixed(2)}`);
Handlebars.registerHelper('formatDate', (date) => date);

async function generateThumbnails() {
  const templatesDir = path.join(__dirname, 'templates');
  const outputDir = path.join(__dirname, 'output');
  const fullOutputDir = path.join(__dirname, 'output-full');

  // Check for parsed sample data
  const sampleDataPath = path.join(__dirname, 'parsed_data.json');
  if (!fs.existsSync(sampleDataPath)) {
    console.error('Error: parsed_data.json not found.');
    console.error('Run this to create it from DynamoDB scan output:');
    console.error(`
cat sample_data.json | node -e "
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const result = {};
for (const item of data.Items) {
  result[item.templateId.S] = JSON.parse(item.sampleDataJson.S);
}
console.log(JSON.stringify(result, null, 2));
" > parsed_data.json
    `);
    process.exit(1);
  }

  const sampleData = JSON.parse(fs.readFileSync(sampleDataPath, 'utf8'));

  // Create output directories
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  if (!fs.existsSync(fullOutputDir)) {
    fs.mkdirSync(fullOutputDir, { recursive: true });
  }

  // Launch browser
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const templateFiles = fs.readdirSync(templatesDir).filter(f => f.endsWith('.hbs'));
  console.log(`Found ${templateFiles.length} templates\n`);

  for (const file of templateFiles) {
    const templateId = file.replace('.hbs', '');
    console.log(`Processing: ${templateId}`);

    try {
      // Read template
      const templateContent = fs.readFileSync(path.join(templatesDir, file), 'utf8');

      // Get sample data for this template
      const data = sampleData[templateId] || {};

      // Compile and render template
      const template = Handlebars.compile(templateContent);
      const html = template(data);

      // Create a page and set content
      const page = await browser.newPage();

      // Set viewport to A4-ish dimensions for PDF-like appearance
      await page.setViewport({ width: 800, height: 1100 });

      // Set the HTML content
      await page.setContent(html, { waitUntil: 'networkidle0' });

      // Take cropped screenshot (top portion - for card thumbnails)
      await page.screenshot({
        path: path.join(outputDir, `${templateId}.png`),
        type: 'png',
        clip: {
          x: 0,
          y: 0,
          width: 800,
          height: 600
        }
      });
      console.log(`  ✓ Cropped: ${templateId}.png`);

      // Take full page screenshot
      await page.screenshot({
        path: path.join(fullOutputDir, `${templateId}.png`),
        type: 'png',
        fullPage: true
      });
      console.log(`  ✓ Full: ${templateId}.png`);

      await page.close();
    } catch (error) {
      console.error(`  ✗ Error: ${error.message}`);
    }
  }

  await browser.close();

  console.log('\n========================================');
  console.log('Done!');
  console.log(`Cropped thumbnails: ${outputDir}`);
  console.log(`Full thumbnails: ${fullOutputDir}`);
  console.log('\nUpload to S3:');
  console.log('  aws s3 sync output/ s3://mkpdfs-{stage}-bucket/marketplace/thumbnails/');
  console.log('  aws s3 sync output-full/ s3://mkpdfs-{stage}-bucket/marketplace/thumbnails-full/');
}

generateThumbnails().catch(console.error);
