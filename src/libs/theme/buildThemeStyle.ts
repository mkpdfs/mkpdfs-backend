import { FONTS } from './fonts';
import { softTint, shadowRgba } from './colorDerive';

/**
 * Build the HTML to inject before </head>: a Google Fonts <link> for the chosen
 * font and a :root override block. Inputs are already validated/normalized
 * (validateThemeFields), so they are safe to interpolate into CSS.
 */
export function buildThemeHead(theme: { brand: string; accent: string; fontKey: string }): string {
  const font = FONTS[theme.fontKey] ?? FONTS['inter-fraunces'];
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
    `<link rel="stylesheet" href="${font.linkHref}">` +
    `<style id="mkpdfs-theme">:root { ${vars} }</style>`
  );
}
