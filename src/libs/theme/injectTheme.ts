/** Insert `fragment` immediately before the first </head> (case-insensitive). */
export function injectIntoHead(html: string, fragment: string): string {
  const idx = html.search(/<\/head>/i);
  if (idx === -1) return fragment + html;
  return html.slice(0, idx) + fragment + html.slice(idx);
}
