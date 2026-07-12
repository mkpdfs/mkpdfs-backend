/**
 * Template-authoring guide served by the `get_authoring_guide` MCP tool (and
 * summarized in the server's `instructions`). Ported from the CLI's embedded
 * `mkp instructions --agent` walkthrough (internal/cli/instr_format.md +
 * instr_example.md in mkpdfs-cli) with CLI-specific steps replaced by MCP tool
 * calls. Helper signatures MUST stay in sync with pdfService.ts.
 */
export const AUTHORING_GUIDE = `# Authoring mkpdfs templates (for agents)

## Template format

A template is **plain HTML with inline CSS** plus Handlebars \`{{placeholders}}\`,
rendered by headless Chromium — flexbox, grid, \`box-shadow\`, and web fonts all
work. There is no proprietary format to learn.

- **Page size** is set in CSS, not a parameter:
  \`@page { size: A4; margin: 2cm; }\` (use \`size: Letter\` for US Letter,
  \`size: A4 landscape\` for landscape).
- **Variables**: \`{{nombre}}\` is replaced with the value of \`nombre\` from the
  \`data\` object you pass to \`generate_pdf\`.
- **Source size cap: 6.5 MiB** per template.

## Helpers (exact signatures — do NOT invent arguments)

| Helper | Usage | Notes |
|---|---|---|
| \`ifEq\` | \`{{#ifEq a b}}…{{else}}…{{/ifEq}}\` | block; loose \`==\` equality |
| \`gt\` | \`{{#if (gt a b)}}…{{/if}}\` | returns a boolean; use as a subexpression |
| \`formatDate\` | \`{{formatDate someDate}}\` | **no format argument**; renders \`toLocaleDateString()\` |
| \`formatCurrency\` | \`{{formatCurrency amount}}\` | **always USD**; no currency argument |
| \`mkpdfsQR\` | \`{{{mkpdfsQR "https://example.com"}}}\` | inline SVG QR code; triple-stache (raw) |

Built-in Handlebars helpers also work: \`{{#each list}}…{{/each}}\` (tables and
repeated rows), \`{{#if x}}…{{/if}}\`, \`{{#unless x}}…{{/unless}}\`,
\`{{#with obj}}…{{/with}}\`, \`{{else}}\`. Inside \`{{#each}}\`, the current item is
\`{{this}}\`.

If you need a formatted date or non-USD currency in a specific style, format it
yourself in the data and emit the string with a plain \`{{variable}}\` — don't
rely on \`formatDate\`/\`formatCurrency\` for that.

## Worked example (copy-pasteable)

\`upload_template\` with \`name: "carta"\` and this \`content\`:

\`\`\`hbs
<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<style>
  @page { size: A4; margin: 2.5cm; }
  body { font-family: Georgia, "Times New Roman", serif; color: #2b2b2b; line-height: 1.7; }
  .fecha { text-align: right; color: #777; font-size: 12px; margin-bottom: 2rem; }
  .saludo { font-size: 22px; color: #b23a48; margin-bottom: 1rem; }
  p { margin: 0 0 1rem; text-align: justify; }
  .firma { margin-top: 3rem; font-style: italic; font-size: 18px; }
</style>
</head>
<body>
  <div class="fecha">{{formatDate fecha}}</div>
  <div class="saludo">Querida {{para}},</div>
  {{#each parrafos}}
  <p>{{this}}</p>
  {{/each}}
  <div class="firma">Siempre tuyo,<br>{{de}}</div>
</body>
</html>
\`\`\`

Then \`generate_pdf\` with the returned \`templateId\` and this \`data\`:

\`\`\`json
{
  "para": "Mariana",
  "de": "Alejandro",
  "fecha": "2026-06-24",
  "parrafos": [
    "Cada mañana desde que te conocí amanece distinta, más clara.",
    "No sé escribir versos, así que te escribo la verdad: me haces feliz.",
    "Guarda esta carta; es el recibo de todo lo que no sé decirte en voz alta."
  ]
}
\`\`\`

The response contains a \`pdfUrl\` (presigned, valid 5 days). Fetch it or hand it
to the user — confirm it exists before reporting success.

## Workflow tips

- \`list_templates\` first: the account may already have the template you need.
- \`get_template\` returns the Handlebars source — read it before editing, then
  \`update_template\` to iterate in place (same templateId, no re-upload).
- To render **many PDFs in one call**, pass \`data\` as a JSON **array** of
  objects — one page set per item, max 50.
- Billing: 1 credit = 1 rendered page. A 402 error means the account is out of
  credits (top up at the dashboard under Billing).
`;

/**
 * Injected into every MCP client's context via the initialize response —
 * compact on purpose; the full walkthrough lives behind get_authoring_guide.
 */
export const SERVER_INSTRUCTIONS = `mkpdfs generates PDFs from Handlebars-over-HTML templates (rendered by headless
Chromium; full CSS support). Templates are plain HTML + inline CSS with
{{placeholders}}; page size via @page CSS. Data is a JSON object matching the
placeholders (or an array of objects, one page set each, max 50).

Before writing your FIRST template, call the get_authoring_guide tool — it has
the exact helper signatures ({{#each}} for tables, ifEq, gt, formatDate,
formatCurrency, {{{mkpdfsQR url}}}) and a complete worked example. Do not invent
helper arguments. 1 credit = 1 rendered page; a 402 means out of credits.`;
