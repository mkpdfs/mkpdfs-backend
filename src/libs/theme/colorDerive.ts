/** Parse "#RGB" or "#RRGGBB" into [r,g,b] (0-255). Assumes already validated. */
function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function toHex(n: number): string {
  return Math.round(n).toString(16).padStart(2, '0');
}

/** Blend `hex` `weight` (default 0.08) over white → a soft tint hex. */
export function softTint(hex: string, weight = 0.08): string {
  const [r, g, b] = hexToRgb(hex);
  const mix = (c: number) => c * weight + 255 * (1 - weight);
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
}

/** rgba() string for soft shadows from a hex color. */
export function shadowRgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
