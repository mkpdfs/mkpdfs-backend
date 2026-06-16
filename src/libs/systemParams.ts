export interface SystemParams {
  today: string; // YYYY-MM-DD (UTC)
  now: string;   // ISO 8601
  year: number;
}

/** Reserved params merged into every render context. Generated once per request. */
export function buildSystemParams(now: Date): SystemParams {
  return {
    today: now.toISOString().slice(0, 10),
    now: now.toISOString(),
    year: now.getUTCFullYear(),
  };
}
