import { describe, expect, it } from 'vitest';
import { injectIntoHead } from './injectTheme';

describe('injectIntoHead', () => {
  it('inserts the fragment immediately before the first </head>', () => {
    const html = '<html><head><style>:root{--brand:#000}</style></head><body>x</body></html>';
    const out = injectIntoHead(html, '<style id="t">Z</style>');
    expect(out).toContain('</style><style id="t">Z</style></head>');
    expect(out.indexOf('id="t"')).toBeLessThan(out.indexOf('</head>'));
  });

  it('is case-insensitive on the </head> tag', () => {
    const out = injectIntoHead('<HEAD></HEAD>', 'FRAG');
    expect(out).toContain('FRAG</HEAD>');
  });

  it('falls back to prepending when there is no </head>', () => {
    const out = injectIntoHead('<body>no head</body>', 'FRAG');
    expect(out.startsWith('FRAG')).toBe(true);
  });
});
