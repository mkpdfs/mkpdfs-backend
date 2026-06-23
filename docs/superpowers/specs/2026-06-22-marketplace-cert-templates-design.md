# Marketplace Certificate Templates (6 landscape, brand-agnostic) — Design

Date: 2026-06-22
Status: Approved-pending-review

## Context

First paying client is a certification-issuing service that produces "constancias"
on behalf of many different schools/companies. They supplied 6 real issued
certificates as style references (NobleProg, Global Lynx, UDLA, Arenal Informática,
Databricks/A+, UPAEP). The brands in those samples are examples only — the
deliverable is 6 **brand-agnostic, fully configurable** certificate templates that
reskin per client via data (logo, colors, recipient, course, signatures, QR, folio).

Decision summary (from brainstorming):
- Scope: all **6 distinct layouts** (structurally different, so 6 templates, not 1).
- Location: **public marketplace** (`category: certificates`) — asset for all mkpdfs users.
- QR: add a backend helper `mkpdfsQR` that generates the QR from a verify URL.
- Signatures: configurable image (URL/data-URI) with line fallback; 1–2 per cert.
- Fidelity: **inspired/clean** — reproduce each layout's structure and feel with the
  system's polished typography, not pixel-perfect tracing.
- Orientation: **landscape** (all samples are). Existing templates stay portrait.

## Goals / Non-goals

**Goals**
- 6 landscape `.hbs` marketplace templates, brand-agnostic, sharing one variable schema.
- A reusable `mkpdfsQR` Handlebars helper (synchronous).
- Landscape support in the PDF render path and the thumbnail generator.
- Seeded + thumbnailed in dev, verified, then prod.

**Non-goals (explicit)**
- No frontend (`mkpdfs-web`) work. Landscape thumbnails will show with a different
  aspect ratio in the grid; if that looks bad it's a separate CSS follow-up.
- No "upload a signature file" UI. Signatures enter as data (URL/data-URI) per
  generation, exactly like the logo does today.
- No pixel-perfect cloning of brand fonts/seals.

## Architecture

### Page geometry (landscape) — `preferCSSPageSize`

`pdfService.ts` currently calls `page.pdf({ format: 'A4', margin: 0 })` (portrait,
hardcoded). Change to add `preferCSSPageSize: true`. Then **each template owns its
geometry** via CSS `@page`:

```css
@page { size: A4 landscape; margin: 0; }
```

- Landscape certs declare `@page { size: A4 landscape }`.
- Existing portrait templates have **no** `@page` rule → Puppeteer falls back to the
  `format: 'A4'` argument → unchanged portrait output. (Low risk; verified during impl.)

This is the right long-term model for a multi-template SaaS: templates, not the
renderer, decide their page size.

### `mkpdfsQR` helper

Handlebars helpers are **synchronous**, so the async `qrcode` API (`toDataURL`)
cannot be used. Use `qrcode-generator` (synchronous, ~10KB, CommonJS — bundles with
esbuild; **not** in the Lambda layer).

```ts
import qrcode from 'qrcode-generator';

Handlebars.registerHelper('mkpdfsQR', function (url: any, options: any) {
  if (!url || typeof url !== 'string') return '';
  const ec = (options?.hash?.ec as string) || 'M';   // error correction
  const qr = qrcode(0, ec as any);                    // 0 = auto-fit version
  qr.addData(url);
  qr.make();
  // scalable SVG, no quiet-zone margin (template controls sizing via CSS)
  return new Handlebars.SafeString(qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true }));
});
```

Usage: `{{mkpdfsQR verifyUrl}}` (optional `{{mkpdfsQR verifyUrl ec="H"}}`). The
template wraps it in a sized box: `.qr { width: 28mm; } .qr svg { width: 100%; height: auto; }`.

**Must be registered identically in `pdfService.ts` AND `scripts/generate-thumbnails.ts`**
(same rule already applied to `mkpdfsFontFaces`).

### Shared variable contract

All 6 templates consume the same schema; each uses the subset it needs and guards
optionals with `{{#if}}` so a user can swap templates without changing their data.

```jsonc
{
  "brand": {
    "logoUrl": "https://… or data:image/png;base64,…",  // primary logo
    "logoUrl2": "…",            // optional 2nd logo (geometric-qr layout)
    "color": "#1a3a8f",         // primary brand color (titles, name, accents)
    "colorSecondary": "#c9a227",// secondary accent (rules, corner fills)
    "name": "Global Lynx"       // org name (footer/kicker)
  },
  "title": "CONSTANCIA",                       // CONSTANCIA / RECONOCIMIENTO / DIPLOMA…
  "preamble": "Se otorga la presente a:",      // line above the recipient
  "recipientName": "Francisco J. Núñez I.",
  "body": "Por haber completado satisfactoriamente el curso:",
  "courseName": "CompTIA Security+",
  "details": "Con una duración de 40 horas, cubriendo análisis de ciberseguridad…",
  "meta": { "hours": "40", "date": "Octubre 2024", "location": "Puebla, Pue." },
  "signatures": [
    { "name": "Lic. Daniel Ortega Vargas", "title": "Chief Executive Officer", "imageUrl": "data:…" },
    { "name": "Mtro. Alejandro Hernández Ruiz", "title": "Instructor", "imageUrl": "" }
  ],
  "verifyUrl": "https://verify.example.com/abc123",   // → mkpdfsQR (qr layouts only)
  "folio": "CERT-2025-001"
}
```

**Signature block (graceful fallback), reused in every template:**
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
`.sigs { display:flex; justify-content:center; gap: 40mm; }` → 1 sig centers, 2 sigs spread.

**Logo:** `{{#if brand.logoUrl}}<img class="logo" src="{{brand.logoUrl}}">{{/if}}`.
Brand colors injected inline via a `:root` style using `{{brand.color}}` /
`{{brand.colorSecondary}}` with sane defaults if absent.

### The 6 templates

| templateId | Reference | Layout signature | QR | Sigs |
|---|---|---|---|---|
| `mp-cert-corporate-diagonal` | NobleProg | Diagonal corner triangles (brand + secondary), big bold title, name in brand color | – | 1 |
| `mp-cert-waves-seal` | Global Lynx | Flowing wave lines (SVG), centered title, circular seal, dual signatures | – | 2 |
| `mp-cert-academic-qr` | UDLA | Clean academic, top logo, verification QR bottom-left, single signature | ✓ | 1 |
| `mp-cert-ornate-frame` | Arenal | Ornamental double border + corner medallions (SVG), ink-style seal | – | 2 |
| `mp-cert-geometric-qr` | Databricks/A+ | Angular geometric color panels, two logos top, QR side, one signature | ✓ | 1 |
| `mp-cert-sidebar-minimal` | UPAEP | Left vertical color bar, left-aligned minimal text, two-line footer | – | 1 |

Each: landscape A4, self-hosted fonts via `{{{mkpdfsFontFaces}}}`, brand-color CSS
vars, the shared signature block, optional QR, optional folio, decorative shapes as
inline SVG/CSS (no external images beyond logo/signatures).

### Seed + thumbnail metadata

- `seed-marketplace.ts`: add 6 entries (`category: 'certificates'`) with realistic
  `sampleDataJson` and a new optional field **`orientation: 'landscape'`** on the
  `MarketplaceTemplate` interface (defaults portrait when absent).
- **Neutral placeholder logos in the public sample data**: the seeded `sampleDataJson`
  for each template uses a small brand-neutral placeholder logo (generic mark + made-up
  org name, embedded data-URI) so public marketplace thumbnails carry no third-party
  trademark. Templates stay brand-agnostic — the logo is always `{{brand.logoUrl}}`.
- **Real brand logos → client only (not seeded)**: deliver a separate, non-public
  handoff with ready-to-use example payloads for the 6 reference brands (NobleProg,
  Global Lynx, UDLA, Arenal Informática, Databricks + A+, UPAEP) — each a JSON `data`
  object with that brand's real logo (fetched from its site, base64 data-URI or URL),
  real signatures, and `verifyUrl`. This goes to the client (e.g.
  `docs/client-handoff/cert-example-payloads.md`, gitignored or kept out of the public
  marketplace seed), NOT into `seed-marketplace.ts`.
- `generate-thumbnails.ts`: register `mkpdfsQR`; read `orientation`; for landscape set
  viewport/clip to 1123×794 (A4 landscape @96dpi); also replace the slow
  `networkidle0` wait with `load` + `document.fonts.ready` (matches the runtime path
  and the existing perf note).

## Files touched

```
mkpdfs-backend/
  src/libs/services/pdfService.ts        # + preferCSSPageSize, + mkpdfsQR helper
  scripts/seed-marketplace.ts            # + 6 entries, + orientation field
  scripts/generate-thumbnails.ts         # + mkpdfsQR, + landscape, + load wait
  scripts/marketplace-templates/
    mp-cert-corporate-diagonal.hbs       # new
    mp-cert-waves-seal.hbs               # new
    mp-cert-academic-qr.hbs              # new
    mp-cert-ornate-frame.hbs             # new
    mp-cert-geometric-qr.hbs             # new
    mp-cert-sidebar-minimal.hbs          # new
  package.json                           # + qrcode-generator (and @types if needed)
```

## Rollout

0. Build 1–2 neutral placeholder logos for the public sample data. Separately, fetch
   the 6 real brand logos for the client handoff payloads (not seeded).
1. Implement helper + `preferCSSPageSize`; `npm run typecheck`.
2. Author the 6 `.hbs`; render locally via `generate-thumbnails.ts --only=<id>` and eyeball.
3. `cdk:deploy:dev` (ships the helper + preferCSSPageSize change).
4. `seed-marketplace.ts dev` → `generate-thumbnails.ts dev --upload`.
5. Verify: generate a PDF from each via dev API/CLI with sample + a real brand payload
   (logo + signature image + verifyUrl). Confirm landscape, QR scans, signatures land,
   existing portrait templates still render portrait.
6. Merge `dev` → `main` (CI deploys prod) → `seed-marketplace.ts prod` →
   `generate-thumbnails.ts prod --upload`.

## Risks / open items

- **`preferCSSPageSize` regression**: existing portrait templates without `@page` must
  stay portrait. Verify in step 5 before prod. Mitigation is trivial (the fallback to
  `format` is documented Puppeteer behavior) but must be checked, not assumed.
- **QR contrast/quiet-zone**: QR needs sufficient light margin around it to scan;
  template gives it a white padded box. Verify a real scan in step 5.
- **`qrcode-generator` types**: ships its own `.d.ts`; if TS complains, add a minimal
  module declaration. No layer change.
- **Thumbnail aspect in web grid** (out of scope): landscape PNGs may letterbox; CSS
  follow-up only if it looks bad.
- **Brand fonts**: inspired/clean fidelity means we use system self-hosted fonts, not
  the exact brand fonts in the samples. Accepted.
- **Third-party trademarks**: resolved — public sample data uses neutral placeholders;
  real brand logos live only in the client handoff payloads, never in the public seed.
