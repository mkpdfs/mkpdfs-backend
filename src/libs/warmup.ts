/**
 * Scheduled keep-warm for the PDF render lambdas (obra#3909).
 *
 * An EventBridge rule (cdk/lib/stacks/api-stack.ts) invokes the function
 * DIRECTLY — not through API Gateway — with exactly WARMUP_EVENT as the event.
 * The handler recognises it before any middleware runs and only warms
 * Chromium: no auth, no subscription row, no credit gate, no debit, no usage
 * stats, no S3/DynamoDB access.
 *
 * The match is strict on purpose: an API Gateway proxy event always carries
 * httpMethod/requestContext/body (the client's JSON is a string inside
 * `body`, parsed later by middy), so no HTTP caller can produce a top-level
 * `warmup` key and skip the API-key check.
 */
import { PdfService } from './services/pdfService';
import { consumeColdStart } from './perf';

export const WARMUP_SOURCE = 'mkpdfs.warmer';

/** Keep in sync with the RuleTargetInput in cdk/lib/stacks/api-stack.ts. */
export const WARMUP_EVENT = Object.freeze({ warmup: true, source: WARMUP_SOURCE });

const HTTP_EVENT_KEYS = ['httpMethod', 'requestContext', 'body', 'headers', 'path', 'resource'];

export function isWarmupEvent(event: unknown): boolean {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  const e = event as Record<string, unknown>;
  if (HTTP_EVENT_KEYS.some((key) => key in e)) return false;
  return e.warmup === true && e.source === WARMUP_SOURCE;
}

export interface WarmupResult {
  warmed: boolean;
  coldStart: boolean;
  browserReused?: boolean;
  browserMs?: number;
  renderMs?: number;
  totalMs: number;
  error?: string;
}

let pdfService: PdfService | null = null;

/**
 * Never throws: EventBridge invokes asynchronously and would retry an error,
 * and a failed warm must not page anyone — a real request on the same broken
 * container fails loudly on its own path.
 */
export async function runWarmup(): Promise<WarmupResult> {
  const t0 = Date.now();
  const coldStart = consumeColdStart();
  let result: WarmupResult;
  try {
    pdfService = pdfService ?? new PdfService();
    const timings = await pdfService.warmup();
    result = { warmed: true, coldStart, ...timings, totalMs: Date.now() - t0 };
  } catch (err) {
    result = {
      warmed: false,
      coldStart,
      totalMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    console.info('[warmup]', JSON.stringify(result));
  } catch {
    // instrumentation must never break the warm
  }
  return result;
}
