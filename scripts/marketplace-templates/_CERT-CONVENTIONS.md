# Shared Certificate Template Conventions

This document holds the canonical snippets referenced by certificate template tasks (Tasks 5-10). Copy these verbatim into each template.

## PLACEHOLDER_LOGO

Neutral, no trademark — generic monogram. Use as `brand.logoUrl` in every sample-data entry:

```
data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNDAiIGhlaWdodD0iNjQiIHZpZXdCb3g9IjAgMCAyNDAgNjQiPjxyZWN0IHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgcng9IjEyIiBmaWxsPSIjMWEzYThmIi8+PHRleHQgeD0iMzIiIHk9IjQyIiBmb250LWZhbWlseT0iQXJpYWwsc2Fucy1zZXJpZiIgZm9udC1zaXplPSIzMCIgZm9udC13ZWlnaHQ9ImJvbGQiIGZpbGw9IiNmZmYiIHRleHQtYW5jaG9yPSJtaWRkbGUiPkE8L3RleHQ+PHRleHQgeD0iNzgiIHk9IjQyIiBmb250LWZhbWlseT0iQXJpYWwsc2Fucy1zZXJpZiIgZm9udC1zaXplPSIyNCIgZm9udC13ZWlnaHQ9IjcwMCIgZmlsbD0iIzFhM2E4ZiI+QWNtZSBBY2FkZW15PC90ZXh0Pjwvc3ZnPg==
```

(Decodes to a 240×64 SVG: navy rounded square with "A" + "Acme Academy" text.)

## PAGE_LANDSCAPE

Put inside each template's `<style>`:

```css
@page { size: A4 landscape; margin: 0; }
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 297mm; height: 210mm; }
.page { width: 297mm; height: 210mm; position: relative; overflow: hidden; background: #fff;
        display: flex; flex-direction: column; }
```

## BRAND_VARS

First rule inside `<style>`, fed by data with safe defaults via Handlebars `{{#if}}`:

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

## LOGO_BLOCK

Handlebars snippet:

```handlebars
{{#if brand.logoUrl}}<img class="logo" src="{{brand.logoUrl}}" alt="">{{/if}}
```

CSS:

```css
.logo { max-height: 22mm; max-width: 70mm; object-fit: contain; }
```

## SIG_BLOCK

Handlebars snippet (1 sig centers, 2 sigs spread; image optional with line fallback):

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

CSS:

```css
.sigs { display: flex; justify-content: center; gap: 36mm; }
.sig { text-align: center; width: 70mm; }
.sig-img { height: 16mm; object-fit: contain; display: block; margin: 0 auto -2mm; }
.sig-line { width: 60mm; height: 1px; background: var(--ink); margin: 0 auto 6px; }
.sig-name { font-family: var(--font-heading); font-size: 14px; font-weight: 600; }
.sig-title { font-size: 9px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin-top: 3px; }
```

## QR_BLOCK

Handlebars snippet:

```handlebars
{{#if verifyUrl}}<div class="qr">{{{mkpdfsQR verifyUrl}}}</div>{{/if}}
```

CSS:

```css
.qr { width: 26mm; height: 26mm; padding: 2mm; background: #fff; }
.qr svg { width: 100%; height: 100%; display: block; }
```

## FOLIO_BLOCK

Handlebars snippet (optional):

```handlebars
{{#if folio}}<div class="folio">{{folio}}</div>{{/if}}
```
