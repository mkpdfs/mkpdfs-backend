/** Theme as stored on a template row. Logo is always a private S3 key. */
export interface Theme {
  brand: string;     // "#RRGGBB"
  accent: string;    // "#RRGGBB"
  fontKey: string;   // a key of FONTS
  logoKey?: string;  // e.g. "users/{userId}/logos/{id}.png"
}

/** Logo as supplied by the client (before server-side resolution to S3). */
export type LogoInput =
  | { source: 'upload'; s3Key: string }  // already uploaded via presigned PUT
  | { source: 'url'; url: string }       // remote URL, ingested server-side
  | null;

/** Theme payload accepted from the client. */
export interface ThemeInput {
  brand: string;
  accent: string;
  fontKey: string;
  logo?: LogoInput;
}
