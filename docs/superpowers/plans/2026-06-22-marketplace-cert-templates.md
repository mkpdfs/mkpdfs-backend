# Marketplace Certificate Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 6 brand-agnostic landscape certificate templates to the public mkpdfs marketplace, plus a synchronous `mkpdfsQR` Handlebars helper and landscape PDF support.

**Architecture:** Each template is a standalone `.hbs` in `scripts/marketplace-templates/` consuming one shared variable contract (logo/colors/recipient/course/signatures/QR/folio). Landscape is enabled by `preferCSSPageSize: true` so each template declares its own `@page { size: A4 landscape }`; portrait templates (no `@page`) are unaffected. A new `mkpdfsQR` helper renders a QR from a verify URL synchronously (Handlebars helpers can't await). Templates are seeded via `seed-marketplace.ts` and thumbnailed via `generate-thumbnails.ts`.

**Tech Stack:** TypeScript, Handlebars, Puppeteer/Chromium, vitest, `qrcode-generator` (new, synchronous), AWS S3 + DynamoDB (marketplace seed).

## Global Constraints

- All 6 templates: `category: 'certificates'`, landscape A4 (`@page { size: A4 landscape; margin: 0 }`), brand-agnostic — logo is always `{{brand.logoUrl}}`, never hardcoded.
- Fonts: self-hosted only, via `{{{mkpdfsFontFaces}}}` helper (no remote `@import`/`<link>`).
- Helpers MUST be registered identically in `src/libs/services/pdfService.ts` AND `scripts/generate-thumbnails.ts`.
- `qrcode-generator` is a runtime dependency bundled by esbuild — NOT added to the Lambda layer.
- Public marketplace sample data uses NEUTRAL placeholder logos (no third-party trademarks). Real brand logos live only in the client handoff (Task 12), never in `seed-marketplace.ts`.
- Tests: `vitest run`. Typecheck: `npm run typecheck` (`tsc --noEmit && tsc -p cdk --noEmit`).
- Shared variable contract (every template uses a subset, optionals guarded by `{{#if}}`):
  ```jsonc
  {
    "brand": { "logoUrl": "", "logoUrl2": "", "color": "#1a3a8f", "colorSecondary": "#c9a227", "name": "" },
    "title": "", "preamble": "", "recipientName": "", "body": "", "courseName": "",
    "details": "", "meta": { "hours": "", "date": "", "location": "" },
    "signatures": [ { "name": "", "title": "", "imageUrl": "" } ],
    "verifyUrl": "", "folio": ""
  }
  ```

---

### Task 1: `mkpdfsQR` Handlebars helper

**Files:**
- Modify: `package.json` (add `qrcode-generator` dependency)
- Modify: `src/libs/services/pdfService.ts` (register helper inside `registerHandlebarsHelpers`, ~line 92)
- Test: `src/libs/services/pdfService.qr.test.ts` (create)

**Interfaces:**
- Produces: Handlebars helper `mkpdfsQR(url: string, options)` → `SafeString` containing an `<svg>` QR. Empty string when `url` is falsy/non-string. Optional `ec` hash param (`"L"|"M"|"Q"|"H"`, default `"M"`). Registered at module load (importing `PdfService` registers it).

- [ ] **Step 1: Install the dependency**

```bash
npm install qrcode-generator@^1.4.4
```
Expected: adds `qrcode-generator` to `dependencies` in `package.json`. (It ships its own `index.d.ts`; no `@types` needed.)

- [ ] **Step 2: Write the failing test**

Create `src/libs/services/pdfService.qr.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import Handlebars from 'handlebars';
import './pdfService'; // importing registers helpers at module load

describe('mkpdfsQR helper', () => {
  it('renders an inline SVG QR for a URL', () => {
    const t = Handlebars.compile('<div class="qr">{{{mkpdfsQR verifyUrl}}}</div>');
    const html = t({ verifyUrl: 'https://verify.example.com/abc123' });
    expect(html).toContain('<svg');
    expect(html).toContain('</svg>');
    expect(html).not.toContain('&lt;svg'); // SafeString, not escaped
  });

  it('renders nothing when url is missing', () => {
    const t = Handlebars.compile('[{{{mkpdfsQR verifyUrl}}}]');
    expect(t({})).toBe('[]');
  });

  it('accepts an error-correction hash param', () => {
    const t = Handlebars.compile('{{{mkpdfsQR verifyUrl ec="H"}}}');
    const html = t({ verifyUrl: 'https://verify.example.com/x' });
    expect(html).toContain('<svg');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/libs/services/pdfService.qr.test.ts`
Expected: FAIL — `mkpdfsQR` is not a registered helper (Handlebars throws "Missing helper: mkpdfsQR").

- [ ] **Step 4: Implement the helper**

At the top of `src/libs/services/pdfService.ts`, add the import alongside the other imports:
```ts
import qrcode from 'qrcode-generator';
```
Inside `registerHandlebarsHelpers()`, after the `mkpdfsFontFaces` helper block (~line 92), add:
```ts
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
```

- [ ] **Step 5: Run test + typecheck to verify pass**

Run: `npx vitest run src/libs/services/pdfService.qr.test.ts && npm run typecheck`
Expected: PASS (3 tests) and typecheck clean.
If TS complains about the default import, change it to `import * as qrcode from 'qrcode-generator';` and re-run.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/libs/services/pdfService.ts src/libs/services/pdfService.qr.test.ts
git commit -m "feat: add synchronous mkpdfsQR Handlebars helper"
```

---

### Task 2: Landscape PDF support via `preferCSSPageSize`

**Files:**
- Modify: `src/libs/services/pdfService.ts:226-235` (the `page.pdf({...})` call)

**Interfaces:**
- Produces: PDF render now honors a template's `@page { size: ... }`. Templates with no `@page` rule still render A4 portrait (fallback to `format`).

- [ ] **Step 1: Add the option**

In `generatePdfFromHtml`, change the `page.pdf` call (currently `format: 'A4', printBackground: true, margin: {...}`) to add `preferCSSPageSize: true`:
```ts
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
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Quick regression sanity (existing portrait template)**

Render an existing portrait marketplace template locally to confirm it stays portrait:
```bash
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  npx ts-node --transpile-only scripts/generate-thumbnails.ts dev --only=mp-cert-completion
```
Open `scripts/marketplace-thumbnails/mp-cert-completion.png` — must still be portrait A4 proportions (taller than wide). (Note: this exercises the thumbnail path, not `page.pdf`, but confirms the template itself is unchanged. The `page.pdf` fallback is verified end-to-end in Task 11.)

- [ ] **Step 4: Commit**

```bash
git add src/libs/services/pdfService.ts
git commit -m "feat: honor CSS @page size in PDF render (preferCSSPageSize)"
```

---

### Task 3: Thumbnail generator — `mkpdfsQR`, landscape, faster wait

**Files:**
- Modify: `scripts/generate-thumbnails.ts` (helper registration ~line 64; main render loop ~line 90-113)
- Modify: `scripts/seed-marketplace.ts` (add `orientation` to the `MarketplaceTemplate` interface, ~line 29-41)

**Interfaces:**
- Consumes: `MarketplaceTemplate.orientation?: 'portrait' | 'landscape'` (Task 3 adds the field; Tasks 5-10 set it).
- Produces: thumbnail generator that registers `mkpdfsQR`, renders landscape templates at 1123×794, and uses a `load` + `fonts.ready` wait.

- [ ] **Step 1: Add `orientation` to the interface**

In `scripts/seed-marketplace.ts`, in the `MarketplaceTemplate` interface, add after `tags: string[];`:
```ts
  orientation?: 'portrait' | 'landscape'; // default portrait; certs are landscape
```
And in the `templates` array type (`Omit<MarketplaceTemplate, ...>`), `orientation` is included automatically since it's part of the interface and optional.

- [ ] **Step 2: Register `mkpdfsQR` in the thumbnail generator**

In `scripts/generate-thumbnails.ts`, add the import near the top (with the other imports):
```ts
import qrcode from 'qrcode-generator';
```
After the `mkpdfsFontFaces` helper registration (~line 67), add the identical helper:
```ts
Handlebars.registerHelper('mkpdfsQR', function (url: any, options: any) {
  if (!url || typeof url !== 'string') return '';
  const ec = (options?.hash?.ec as string) || 'M';
  const qr = qrcode(0, ec as any);
  qr.addData(url);
  qr.make();
  return new Handlebars.SafeString(qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true }));
});
```

- [ ] **Step 3: Add landscape dimensions + per-template orientation**

In `scripts/generate-thumbnails.ts`, below the existing `A4_W`/`A4_H` constants (~line 41), add:
```ts
// A4 landscape at 96dpi
const A4_LAND_W = 1123;
const A4_LAND_H = 794;
```
In the render loop (the `for (const t of list)` body), replace the viewport + screenshot-clip block so it picks dimensions by orientation. Replace:
```ts
      const page = await browser.newPage();
      await page.setViewport({ width: A4_W, height: A4_H, deviceScaleFactor: 2 });
      await page.setContent(html, { waitUntil: 'networkidle0' });
      await page.evaluate(async () => {
        await (document as any).fonts.ready;
      });

      const outPath = path.join(OUTPUT_DIR, `${t.templateId}.png`);
      const shot = Buffer.from(
        await page.screenshot({
          type: 'png',
          clip: { x: 0, y: 0, width: A4_W, height: A4_H },
        })
      );
```
with:
```ts
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
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Regression render (portrait still works)**

Run: `CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npx ts-node --transpile-only scripts/generate-thumbnails.ts dev --only=mp-cert-completion`
Expected: `✓ rendered mp-cert-completion.png`, still portrait proportions.

- [ ] **Step 6: Commit**

```bash
git add scripts/generate-thumbnails.ts scripts/seed-marketplace.ts
git commit -m "feat: thumbnail generator supports landscape + mkpdfsQR"
```

---

### Task 4: Shared template conventions + neutral placeholder logo

This task produces no shipped file on its own — it locks the reusable snippets every template task (5-10) copies verbatim, and the placeholder logo used in all 6 sample-data entries. Treat the code blocks here as the canonical source; Tasks 5-10 reference them by name.

**Files:**
- Create: `scripts/marketplace-templates/_CERT-CONVENTIONS.md` (reference doc, committed; not seeded — `seed-marketplace.ts` only reads `${templateId}.hbs` files listed in the `templates` array, so a `.md` here is ignored)

**Interfaces:**
- Produces: named snippets `PAGE_LANDSCAPE`, `BRAND_VARS`, `LOGO_BLOCK`, `SIG_BLOCK`, `QR_BLOCK`, and `PLACEHOLDER_LOGO` (a data-URI) — referenced by Tasks 5-10.

- [ ] **Step 1: Write the conventions doc**

Create `scripts/marketplace-templates/_CERT-CONVENTIONS.md` with these canonical snippets:

`PLACEHOLDER_LOGO` (neutral, no trademark — generic monogram; use as `brand.logoUrl` in every sample-data entry):
```
data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNDAiIGhlaWdodD0iNjQiIHZpZXdCb3g9IjAgMCAyNDAgNjQiPjxyZWN0IHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgcng9IjEyIiBmaWxsPSIjMWEzYThmIi8+PHRleHQgeD0iMzIiIHk9IjQyIiBmb250LWZhbWlseT0iQXJpYWwsc2Fucy1zZXJpZiIgZm9udC1zaXplPSIzMCIgZm9udC13ZWlnaHQ9ImJvbGQiIGZpbGw9IiNmZmYiIHRleHQtYW5jaG9yPSJtaWRkbGUiPkE8L3RleHQ+PHRleHQgeD0iNzgiIHk9IjQyIiBmb250LWZhbWlseT0iQXJpYWwsc2Fucy1zZXJpZiIgZm9udC1zaXplPSIyNCIgZm9udC13ZWlnaHQ9IjcwMCIgZmlsbD0iIzFhM2E4ZiI+QWNtZSBBY2FkZW15PC90ZXh0Pjwvc3ZnPg==
```
(This decodes to a 240×64 SVG: a navy rounded square with "A" + the text "Acme Academy". A made-up brand.)

`PAGE_LANDSCAPE` — put inside each template's `<style>`:
```css
@page { size: A4 landscape; margin: 0; }
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 297mm; height: 210mm; }
.page { width: 297mm; height: 210mm; position: relative; overflow: hidden; background: #fff;
        display: flex; flex-direction: column; }
```

`BRAND_VARS` — first rule inside `<style>`, fed by data with safe defaults via Handlebars `{{#if}}`:
```html
<style>
  {{{mkpdfsFontFaces}}}
  :root {
    --brand: {{#if brand.color}}{{brand.color}}{{else}}#1a3a8f{{/if}};
    --brand-2: {{#if brand.colorSecondary}}{{brand.colorSecondary}}{{else}}#c9a227{{/if}};
    --ink: #16151A; --muted: #5b5b66; --line: #d8d8de;
    --font-heading: 'Fraunces', Georgia, serif;
    --font-body: 'Inter', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;
  }
  /* ...rest of template styles... */
</style>
```

`LOGO_BLOCK`:
```handlebars
{{#if brand.logoUrl}}<img class="logo" src="{{brand.logoUrl}}" alt="">{{/if}}
```
with `.logo { max-height: 22mm; max-width: 70mm; object-fit: contain; }`.

`SIG_BLOCK` (1 sig centers, 2 sigs spread; image optional with line fallback):
```handlebars
<div class="sigs">
  {{#each signatures}}
    <div class="sig">
      {{#if imageUrl}}<img class="sig-img" src="{{imageUrl}}" alt="">{{/if}}
      <div class="sig-line"></div>
      <div class="sig-name">{{name}}</div>
      {{#if title}}<div class="sig-title">{{title}}</div>{{/if}}
    </div>
  {{/each}}
</div>
```
```css
.sigs { display: flex; justify-content: center; gap: 36mm; }
.sig { text-align: center; width: 70mm; }
.sig-img { height: 16mm; object-fit: contain; display: block; margin: 0 auto -2mm; }
.sig-line { width: 60mm; height: 1px; background: var(--ink); margin: 0 auto 6px; }
.sig-name { font-family: var(--font-heading); font-size: 14px; font-weight: 600; }
.sig-title { font-size: 9px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin-top: 3px; }
```

`QR_BLOCK` (only the qr layouts):
```handlebars
{{#if verifyUrl}}<div class="qr">{{{mkpdfsQR verifyUrl}}}</div>{{/if}}
```
```css
.qr { width: 26mm; height: 26mm; padding: 2mm; background: #fff; }
.qr svg { width: 100%; height: 100%; display: block; }
```

`FOLIO_BLOCK` (optional):
```handlebars
{{#if folio}}<div class="folio">{{folio}}</div>{{/if}}
```

- [ ] **Step 2: Verify the placeholder logo decodes**

Run: `echo 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNDAiIGhlaWdodD0iNjQiIHZpZXdCb3g9IjAgMCAyNDAgNjQiPjxyZWN0IHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgcng9IjEyIiBmaWxsPSIjMWEzYThmIi8+PHRleHQgeD0iMzIiIHk9IjQyIiBmb250LWZhbWlseT0iQXJpYWwsc2Fucy1zZXJpZiIgZm9udC1zaXplPSIzMCIgZm9udC13ZWlnaHQ9ImJvbGQiIGZpbGw9IiNmZmYiIHRleHQtYW5jaG9yPSJtaWRkbGUiPkE8L3RleHQ+PHRleHQgeD0iNzgiIHk9IjQyIiBmb250LWZhbWlseT0iQXJpYWwsc2Fucy1zZXJpZiIgZm9udC1zaXplPSIyNCIgZm9udC13ZWlnaHQ9IjcwMCIgZmlsbD0iIzFhM2E4ZiI+QWNtZSBBY2FkZW15PC90ZXh0Pjwvc3ZnPg==' | base64 -d`
Expected: prints valid `<svg ...>...</svg>` markup.

- [ ] **Step 3: Commit**

```bash
git add scripts/marketplace-templates/_CERT-CONVENTIONS.md
git commit -m "docs: shared certificate template conventions + placeholder logo"
```

---

### Tasks 5-10: The six templates

Each template task has the SAME shape. For every template: (a) write `scripts/marketplace-templates/<id>.hbs` using the Task 4 snippets + the layout spec below, (b) add its seed entry to the `templates` array in `scripts/seed-marketplace.ts` with `orientation: 'landscape'`, (c) render its thumbnail, (d) eyeball it against the reference, (e) commit. No automated test — the deliverable is visual; the gate is the rendered PNG.

**Common requirements for every `.hbs`:**
- Start `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">` then `<style>` containing `{{{mkpdfsFontFaces}}}`, `BRAND_VARS`, `PAGE_LANDSCAPE`, and layout CSS.
- Use `LOGO_BLOCK`, `SIG_BLOCK`, and (where noted) `QR_BLOCK` / `FOLIO_BLOCK` verbatim from Task 4.
- Decorative shapes (triangles, waves, frames, panels, bars) are inline SVG or CSS — no external images beyond logo/signature/QR.
- All text comes from variables: `{{title}}`, `{{preamble}}`, `{{recipientName}}`, `{{body}}`, `{{courseName}}`, `{{details}}`, `{{meta.hours}}`, `{{meta.date}}`, `{{meta.location}}`, `{{brand.name}}`. Guard optionals with `{{#if}}`.

**Common seed-entry shape** (append inside the `// Certificates` section of the `templates` array):
```ts
  {
    templateId: '<id>',
    category: 'certificates',
    orientation: 'landscape',
    name: '<Name>',
    description: '<one-line description>',
    tags: ['certificate', 'constancia', /* layout-specific */],
    popularity: 0,
    sampleDataJson: JSON.stringify(<sampleData below>)
  },
```

**Common render+eyeball step** (replace `<id>`):
```bash
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  npx ts-node --transpile-only scripts/generate-thumbnails.ts dev --only=<id>
open scripts/marketplace-thumbnails/<id>.png   # must be landscape, brand colors applied, sigs/QR placed
```

**Common commit step** (replace `<id>`):
```bash
git add scripts/marketplace-templates/<id>.hbs scripts/seed-marketplace.ts scripts/marketplace-thumbnails/<id>.png
git commit -m "feat: <id> marketplace certificate template"
```

---

### Task 5: `mp-cert-corporate-diagonal` (NobleProg style)

**Layout:** Reference image 1. Two filled diagonal triangles in the top-left and bottom-right corners (brand color with a thin `--brand-2` gold edge — two stacked CSS triangles). Logo top-right. Centered column: very large bold `{{title}}` (heading font, ~46px), `{{preamble}}`, `{{recipientName}}` in `--brand` (~34px), `{{body}}`, `{{courseName}}` (serif, bold), `{{details}}`. One centered signature (`SIG_BLOCK`). No QR. Optional `FOLIO_BLOCK` bottom-left.

- [ ] **Step 1:** Write `scripts/marketplace-templates/mp-cert-corporate-diagonal.hbs` per the spec above using Task 4 snippets.
- [ ] **Step 2:** Add the seed entry with `name: 'Corporate Diagonal Certificate'`, `tags: ['certificate','constancia','corporate','course']`, and sampleData:
```jsonc
{
  "brand": { "logoUrl": "<PLACEHOLDER_LOGO>", "color": "#1a3a8f", "colorSecondary": "#c9a227", "name": "Acme Academy" },
  "title": "Constancia", "preamble": "Otorga la presente constancia a:",
  "recipientName": "John Eymar Rodríguez Arteaga",
  "body": "Por haber cursado satisfactoriamente el curso de:",
  "courseName": "WSO2 Identity Server: Gestión de Identidad y Acceso",
  "details": "Con duración de 21 horas.",
  "meta": { "hours": "21", "date": "Junio 2026", "location": "" },
  "signatures": [ { "name": "Director Académico", "title": "Instructor", "imageUrl": "" } ],
  "folio": "AC-2026-0001"
}
```
(Replace `<PLACEHOLDER_LOGO>` with the data-URI from Task 4.)
- [ ] **Step 3:** Render + eyeball (common step, `<id>=mp-cert-corporate-diagonal`).
- [ ] **Step 4:** Commit (common step).

---

### Task 6: `mp-cert-waves-seal` (Global Lynx style)

**Layout:** Reference image 2. Light-blue flowing wave lines top-right and bottom-left (inline SVG `<path>` strokes in `--brand` at low opacity). Logo top-center. Centered: `{{title}}` big in `--brand`, `{{preamble}}`, `{{recipientName}}` in a script/heading font in `--brand` with an underline, `{{body}}`, `{{courseName}}` (bold, letter-spaced), `{{details}}`. A circular seal (inline SVG ring with `{{brand.name}}` around it — reuse the seal SVG pattern from `mp-cert-completion.hbs` but ringed text). **Two** signatures via `SIG_BLOCK`. No QR.

- [ ] **Step 1:** Write `scripts/marketplace-templates/mp-cert-waves-seal.hbs`.
- [ ] **Step 2:** Add seed entry, `name: 'Waves & Seal Certificate'`, `tags: ['certificate','constancia','seal','formal']`, sampleData:
```jsonc
{
  "brand": { "logoUrl": "<PLACEHOLDER_LOGO>", "color": "#15428b", "colorSecondary": "#9bb8e6", "name": "Acme Academy" },
  "title": "Constancia", "preamble": "Se otorga el presente constancia a:",
  "recipientName": "Francisco J. Núñez I.",
  "body": "Por haber completado satisfactoriamente el curso:",
  "courseName": "CompTIA Security+",
  "details": "Con una duración de 40 horas, cubriendo análisis de ciberseguridad, gestión de vulnerabilidades, detección de amenazas y respuesta a incidentes en entornos empresariales.",
  "meta": { "hours": "40", "date": "Octubre 2024", "location": "" },
  "signatures": [
    { "name": "Lic. Daniel Ortega Vargas", "title": "Chief Executive Officer", "imageUrl": "" },
    { "name": "Mtro. Alejandro Hernández Ruiz", "title": "Instructor", "imageUrl": "" }
  ]
}
```
- [ ] **Step 3:** Render + eyeball.
- [ ] **Step 4:** Commit.

---

### Task 7: `mp-cert-academic-qr` (UDLA style)

**Layout:** Reference image 3. Clean academic. Soft grey swoosh in the background (one large inline SVG path, very light). Logo top-center. `{{brand.name}}` as a large heading line, `{{preamble}}` ("Certifica que:"), `{{recipientName}}` very large bold black on a subtle highlight band, `{{body}}`, `{{meta.location}} {{meta.date}}` right-aligned. `QR_BLOCK` bottom-left with a "Verifícalo en:" label and `{{verifyUrl}}` text under it. One signature (`SIG_BLOCK`) bottom-center-right.

- [ ] **Step 1:** Write `scripts/marketplace-templates/mp-cert-academic-qr.hbs` (uses `QR_BLOCK`).
- [ ] **Step 2:** Add seed entry, `name: 'Academic Certificate (QR)'`, `tags: ['certificate','constancia','academic','qr','university']`, sampleData:
```jsonc
{
  "brand": { "logoUrl": "<PLACEHOLDER_LOGO>", "color": "#8a1538", "colorSecondary": "#b0b0b8", "name": "Universidad Acme" },
  "title": "Constancia", "preamble": "Certifica que:",
  "recipientName": "Miguel Aramis Ramírez Ibarra",
  "body": "Ha participado y aprobado satisfactoriamente el curso de Desarrollo de software",
  "courseName": "Desarrollo de software",
  "meta": { "hours": "", "date": "20 de octubre 2024", "location": "Puebla, Pue." },
  "signatures": [ { "name": "Marlena León Mendoza", "title": "Vicerrectora Académica", "imageUrl": "" } ],
  "verifyUrl": "https://certificados.example.edu/verify/1261958CBA8A"
}
```
- [ ] **Step 3:** Render + eyeball — confirm the QR renders and is crisp.
- [ ] **Step 4:** Commit.

---

### Task 8: `mp-cert-ornate-frame` (Arenal style)

**Layout:** Reference image 4. Ornamental double border in `--brand` around the whole page (outer thick + inner thin rule via nested bordered divs) with a small decorative medallion in each of the 4 corners (inline SVG rosette). Logo top-center. `{{title}}` ("Diploma"), `{{preamble}}` ("Concedido a"), `{{recipientName}}` bold, `{{body}}`, `{{courseName}}` big bold, `{{details}}`. **Two** signatures (`SIG_BLOCK`) with a small ink-style stamp SVG between/near them. No QR. Small print line `{{meta.location}}` at the bottom.

- [ ] **Step 1:** Write `scripts/marketplace-templates/mp-cert-ornate-frame.hbs`.
- [ ] **Step 2:** Add seed entry, `name: 'Ornate Frame Diploma'`, `tags: ['certificate','diploma','ornate','formal','frame']`, sampleData:
```jsonc
{
  "brand": { "logoUrl": "<PLACEHOLDER_LOGO>", "color": "#1f6fb2", "colorSecondary": "#7fb0d8", "name": "Acme Informática" },
  "title": "Diploma", "preamble": "Concedido a",
  "recipientName": "Miguel Aramis Ramírez Ibarra",
  "body": "que ha realizado, con aprovechamiento, el curso de:",
  "courseName": "Máster en Programación",
  "details": "Tras desarrollar el temario del curso y realizadas las prácticas correspondientes, ha demostrado un alto nivel de interés, superando las pruebas de aptitud, por lo que consigue un grado de NOTABLE.",
  "meta": { "hours": "", "date": "", "location": "Enseñanza no reglada sin carácter oficial" },
  "signatures": [
    { "name": "El Director", "title": "", "imageUrl": "" },
    { "name": "El Jefe de Estudios", "title": "", "imageUrl": "" }
  ]
}
```
- [ ] **Step 3:** Render + eyeball.
- [ ] **Step 4:** Commit.

---

### Task 9: `mp-cert-geometric-qr` (Databricks/A+ style)

**Layout:** Reference image 5. Angular geometric color panels down the left edge and bottom-right (overlapping CSS clip-path / SVG polygons in `--brand` + a darker shade). **Two logos** top: `{{brand.logoUrl}}` top-left, `{{#if brand.logoUrl2}}{{brand.logoUrl2}}{{/if}}` top-right. `{{title}}` ("Reconocimiento a:") left-aligned, `{{recipientName}}` bold, `{{body}}`. One signature (`SIG_BLOCK`) left of center. `QR_BLOCK` on the right. Footer line `Fecha: {{meta.date}}` bottom-left.

- [ ] **Step 1:** Write `scripts/marketplace-templates/mp-cert-geometric-qr.hbs` (uses `QR_BLOCK`; uses `brand.logoUrl2`).
- [ ] **Step 2:** Add seed entry, `name: 'Geometric Certificate (QR)'`, `tags: ['certificate','constancia','geometric','qr','modern']`, sampleData:
```jsonc
{
  "brand": { "logoUrl": "<PLACEHOLDER_LOGO>", "logoUrl2": "<PLACEHOLDER_LOGO>", "color": "#176b2c", "colorSecondary": "#0c3d18", "name": "Acme Capacitación" },
  "title": "Reconocimiento a:", "preamble": "",
  "recipientName": "Victor Manuel Coutiño Silva",
  "body": "Por su participación y aprovechamiento en el programa.",
  "meta": { "hours": "", "date": "23 de octubre del 2024", "location": "" },
  "signatures": [ { "name": "Eduardo Barrón Delgado", "title": "Director académico", "imageUrl": "" } ],
  "verifyUrl": "https://verify.example.com/recon/VMCS-2024"
}
```
- [ ] **Step 3:** Render + eyeball.
- [ ] **Step 4:** Commit.

---

### Task 10: `mp-cert-sidebar-minimal` (UPAEP style)

**Layout:** Reference image 6. Full-height vertical color bar (`--brand`) down the left ~12mm edge. All content left-aligned with generous left margin. Logo top-left. `{{brand.name}} otorga la presente`, `{{title}}` ("Constancia"), `A: {{recipientName}}` very large bold, `{{body}}`, `{{details}}`, `Valor curricular: {{meta.hours}} horas`. Footer: an italic motto line + `{{meta.location}} {{meta.date}}` bottom-left, and one signature (`SIG_BLOCK`, but left-aligned not centered — override `.sigs { justify-content: flex-end }`) bottom-right. No QR.

- [ ] **Step 1:** Write `scripts/marketplace-templates/mp-cert-sidebar-minimal.hbs`.
- [ ] **Step 2:** Add seed entry, `name: 'Sidebar Minimal Certificate'`, `tags: ['certificate','constancia','minimal','sidebar','university']`, sampleData:
```jsonc
{
  "brand": { "logoUrl": "<PLACEHOLDER_LOGO>", "color": "#d3122a", "colorSecondary": "#8a8a90", "name": "Universidad Acme" },
  "title": "Constancia", "preamble": "otorga la presente",
  "recipientName": "Victor Manuel Coutiño Silva",
  "body": "Por su participación en el Curso Virtual de: Bootcamps de programación",
  "details": "Impartido por esta Universidad del 15 de mayo de 2025 al 15 de julio de 2025.",
  "meta": { "hours": "40", "date": "Agosto 2024", "location": "Puebla, Pue." },
  "signatures": [ { "name": "Ing. Cesar Orozco Gamiño", "title": "Director Académico de Ingenierías", "imageUrl": "" } ]
}
```
- [ ] **Step 3:** Render + eyeball.
- [ ] **Step 4:** Commit.

---

### Task 11: Deploy to dev, seed, thumbnail, verify end-to-end

**Files:** none (deploy + scripts).

**Interfaces:**
- Consumes: all backend changes (Tasks 1-3) + 6 templates (Tasks 5-10).
- Produces: live dev marketplace with the 6 certs; verified landscape PDF + QR + signature image + portrait-regression.

- [ ] **Step 1: Typecheck + full test suite**

Run: `npm run typecheck && npx vitest run`
Expected: clean typecheck, all tests pass (incl. Task 1's QR tests).

- [ ] **Step 2: Deploy backend to dev**

Run: `npm run cdk:deploy:dev`
Expected: deploy completes (check end of log for success — CFN can exit 0 on abort). This ships `mkpdfsQR` + `preferCSSPageSize`.

- [ ] **Step 3: Seed dev marketplace**

Run: `AWS_PROFILE=rocketeast npx ts-node scripts/seed-marketplace.ts dev`
Expected: `✅ Successfully seeded` listing the 6 new certificate templates (and existing ones).

- [ ] **Step 4: Generate + upload all thumbnails to dev**

Run: `CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" AWS_PROFILE=rocketeast npx ts-node --transpile-only scripts/generate-thumbnails.ts dev --upload`
Expected: all templates render; the 6 certs are landscape; uploaded to `s3://mkpdfs-dev-bucket/marketplace/thumbnails/`.

- [ ] **Step 5: End-to-end PDF verification (real payload)**

Generate a PDF from one QR template and one non-QR template against dev, passing a real-ish payload that includes a signature image (a small transparent PNG data-URI) and a `verifyUrl`. Use the dev API or `mkp` CLI with a dev API key. For each of `mp-cert-academic-qr` (QR + sig image) and `mp-cert-corporate-diagonal` (no QR):
  - Confirm the output PDF is **landscape** A4.
  - Confirm the QR scans (phone camera) and resolves to `verifyUrl`.
  - Confirm the signature image lands above the signature line.
  - Confirm brand colors from the payload are applied.

- [ ] **Step 6: Portrait regression**

Generate a PDF from an existing portrait template (e.g. `mp-cert-completion`) against dev. Confirm it is still **portrait** A4 (this proves `preferCSSPageSize` didn't regress templates without `@page`).

- [ ] **Step 7: Commit any thumbnail PNGs not already committed**

```bash
git add scripts/marketplace-thumbnails/
git commit -m "chore: dev thumbnails for certificate templates" || echo "nothing to commit"
```

---

### Task 12: Client handoff payloads (real brand logos — NOT seeded)

**Files:**
- Create: `docs/client-handoff/cert-example-payloads.md` (kept out of the public seed; if logos are large, gitignore the embedded-logo variant)

**Interfaces:**
- Produces: 6 ready-to-use `data` JSON payloads (one per template) using the real reference brands' logos + signatures, for the client to adapt per brand.

- [ ] **Step 1: Fetch the real brand logos**

For each brand (NobleProg, Global Lynx, UDLA, Arenal Informática, Databricks, A+, UPAEP), locate the official logo (WebSearch/WebFetch for the site, then `curl` the asset). Downscale to ≤~40KB, base64-encode:
```bash
# example per logo
curl -sL '<logo-url>' -o /tmp/logo.png
base64 -i /tmp/logo.png | tr -d '\n' > /tmp/logo.b64
```

- [ ] **Step 2: Write the handoff doc**

Create `docs/client-handoff/cert-example-payloads.md`: for each `templateId`, a fenced JSON block matching that template's sampleData shape but with the brand's real `logoUrl` (`data:image/png;base64,<...>`), real `signatures` (with `imageUrl` if a signature PNG is available), and a real `verifyUrl` for the QR templates. Add a short note: "the logo and signature images are passed in the `data` of each `POST /v1/pdf/generate` call; swap them per brand."

- [ ] **Step 3: Commit**

```bash
git add docs/client-handoff/cert-example-payloads.md
git commit -m "docs: client handoff — example payloads with real brand logos"
```

---

### Task 13: Promote to production

**Files:** none.

- [ ] **Step 1: Merge dev → main**

```bash
git checkout main && git merge dev && git push origin main
```
Expected: CI (`deploy.yml`) deploys CDK to prod on push to `main`.

- [ ] **Step 2: Wait for CI prod deploy to finish**

Confirm the GitHub Actions deploy succeeded before seeding.

- [ ] **Step 3: Seed prod marketplace**

Run: `AWS_PROFILE=rocketeast npx ts-node scripts/seed-marketplace.ts prod`
Expected: 6 certs seeded to prod.

- [ ] **Step 4: Generate + upload prod thumbnails**

Run: `CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" AWS_PROFILE=rocketeast npx ts-node --transpile-only scripts/generate-thumbnails.ts prod --upload`
Expected: 6 landscape thumbnails uploaded to `s3://mkpdfs-prod-bucket/marketplace/thumbnails/`.

- [ ] **Step 5: Smoke-check prod**

Generate one PDF from a cert template against prod (landscape + QR). If routes return `{"message":"Missing Authentication Token"}`, force a fresh deployment: `aws apigateway create-deployment --rest-api-id <prod-id> --stage-name prod --profile rocketeast` (known gotcha). Otherwise done.

---

## Self-Review

**Spec coverage:**
- 6 templates → Tasks 5-10 ✓ (one each, all `category: certificates`, `orientation: landscape`).
- Shared variable contract → Task 4 conventions + used in every template ✓.
- Configurable signatures (image + line fallback, 1-2) → `SIG_BLOCK` (Task 4), 2-sig in Tasks 6 & 8 ✓.
- `mkpdfsQR` helper → Task 1; registered in thumbnails → Task 3; used in Tasks 7 & 9 ✓.
- Landscape via `preferCSSPageSize` → Task 2; thumbnail landscape → Task 3 ✓.
- Neutral placeholders public → Task 4 `PLACEHOLDER_LOGO` + Tasks 5-10 sampleData ✓.
- Real logos client-only → Task 12 ✓ (not in seed).
- Seed + thumbnail + dev verify + prod → Tasks 11 & 13 ✓.
- Portrait regression guard → Task 2 step 3, Task 11 step 6 ✓.

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to". Code shown for every code step; layout tasks give concrete structure + full sampleData (the `.hbs` is the visual artifact, gated by render+eyeball, which is the correct test for visual output).

**Type consistency:** `orientation?: 'portrait'|'landscape'` defined in Task 3, set in Tasks 5-10, read in Task 3's render loop — consistent. `mkpdfsQR(url, options)` + `options.hash.ec` consistent across Tasks 1 & 3. `brand.logoUrl`/`logoUrl2`, `signatures[].imageUrl`, `verifyUrl`, `meta.{hours,date,location}` consistent across the contract and all sampleData.
