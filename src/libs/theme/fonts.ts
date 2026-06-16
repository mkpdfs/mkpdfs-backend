export interface FontDef {
  label: string;
  linkHref: string;     // Google Fonts CSS2 stylesheet URL
  headingStack: string; // CSS font-family value for headings
  bodyStack: string;    // CSS font-family value for body
}

const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const SERIF = `Georgia, 'Times New Roman', serif`;

export const FONTS: Record<string, FontDef> = {
  'inter-fraunces': {
    label: 'Inter + Fraunces',
    linkHref:
      'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600;700&display=swap',
    headingStack: `'Fraunces', ${SERIF}`,
    bodyStack: `'Inter', ${SANS}`,
  },
  'inter-inter': {
    label: 'Inter',
    linkHref: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap',
    headingStack: `'Inter', ${SANS}`,
    bodyStack: `'Inter', ${SANS}`,
  },
  'playfair-lato': {
    label: 'Playfair Display + Lato',
    linkHref:
      'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600;700&family=Lato:wght@400;700&display=swap',
    headingStack: `'Playfair Display', ${SERIF}`,
    bodyStack: `'Lato', ${SANS}`,
  },
  'poppins-poppins': {
    label: 'Poppins',
    linkHref: 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap',
    headingStack: `'Poppins', ${SANS}`,
    bodyStack: `'Poppins', ${SANS}`,
  },
  'montserrat-opensans': {
    label: 'Montserrat + Open Sans',
    linkHref:
      'https://fonts.googleapis.com/css2?family=Montserrat:wght@500;600;700&family=Open+Sans:wght@400;600&display=swap',
    headingStack: `'Montserrat', ${SANS}`,
    bodyStack: `'Open Sans', ${SANS}`,
  },
  'lora-source-sans': {
    label: 'Lora + Source Sans 3',
    linkHref:
      'https://fonts.googleapis.com/css2?family=Lora:wght@500;600;700&family=Source+Sans+3:wght@400;600&display=swap',
    headingStack: `'Lora', ${SERIF}`,
    bodyStack: `'Source Sans 3', ${SANS}`,
  },
  'space-grotesk-inter': {
    label: 'Space Grotesk + Inter',
    linkHref:
      'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&display=swap',
    headingStack: `'Space Grotesk', ${SANS}`,
    bodyStack: `'Inter', ${SANS}`,
  },
  'dmserif-dmsans': {
    label: 'DM Serif Display + DM Sans',
    linkHref:
      'https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@400;500;700&display=swap',
    headingStack: `'DM Serif Display', ${SERIF}`,
    bodyStack: `'DM Sans', ${SANS}`,
  },
};

export const DEFAULT_FONT_KEY = 'inter-fraunces';

export function isFontKey(key: unknown): key is string {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(FONTS, key);
}
