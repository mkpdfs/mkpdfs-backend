import { FONTS } from './fonts';
import { FONT_FACE_CSS, DEFAULT_FONT_FACE_CSS } from './generated/fontFaces';
import { softTint, shadowRgba } from './colorDerive';

/**
 * Build the HTML to inject before </head>: self-hosted @font-face rules for the
 * chosen font (inlined woff2 data: URIs — no network fetch at render time) and
 * a :root override block. Inputs are already validated/normalized
 * (validateThemeFields), so they are safe to interpolate into CSS.
 */
export function buildThemeHead(theme: { brand: string; accent: string; fontKey: string }): string {
  const font = FONTS[theme.fontKey] ?? FONTS['inter-fraunces'];
  const faces = FONT_FACE_CSS[theme.fontKey] ?? DEFAULT_FONT_FACE_CSS;
  const vars = [
    `--brand: ${theme.brand};`,
    `--brand-soft: ${softTint(theme.brand)};`,
    `--brand-shadow: ${shadowRgba(theme.brand, 0.28)};`,
    `--accent: ${theme.accent};`,
    `--accent-soft: ${softTint(theme.accent)};`,
    `--font-heading: ${font.headingStack};`,
    `--font-body: ${font.bodyStack};`,
  ].join(' ');
  return (
    `<style id="mkpdfs-fonts">${faces}</style>` +
    `<style id="mkpdfs-theme">:root { ${vars} }</style>`
  );
}
