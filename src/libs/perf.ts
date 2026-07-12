/**
 * Per-request performance instrumentation for the PDF hot path
 * (docs/pdf-generation-performance-review-2026-07-11.md, P0).
 *
 * One PerfTrace is created by the auth middleware and threaded through the
 * request via `event.__perf`; stages are recorded with `mark()` (sequential
 * middleware phases, measured since the previous mark) and `span()`
 * (self-timed blocks inside pdfService — safe for Promise.all overlap).
 * debitCreditsMiddleware emits the single structured line at the end of the
 * billing chain:
 *
 *   [perf] {"route":"pdf_generate","totalMs":…,"coldStart":…,"pageCount":…,
 *           "stages":{"auth":…,"subscription":…,"creditGate":…,"templateRow":…,
 *                     "templateCompile":…,"theme":…,"compose":…,"browser":…,
 *                     "setContent":…,"fontWait":…,"pdfPrint":…,"s3Upload":…,
 *                     "presign":…,"email":…,"debit":…},
 *           "flags":{"browserReused":…,"templateCacheHit":…,"logoCacheHit":…}}
 *
 * Logs Insights (cold vs warm percentiles):
 *   filter @message like /\[perf\]/
 *   | parse @message '[perf] *' as j | ... pct(totalMs, 95) by coldStart
 */

// First emit from a container reports coldStart: true, all later ones false.
let containerIsCold = true;

export class PerfTrace {
  private readonly t0 = Date.now();
  private lastMark = this.t0;
  private readonly stages: Record<string, number> = {};
  private readonly flags: Record<string, boolean | number | string> = {};

  /** Record time elapsed since the previous mark under `stage`. */
  mark(stage: string): void {
    const now = Date.now();
    this.stages[stage] = (this.stages[stage] || 0) + (now - this.lastMark);
    this.lastMark = now;
  }

  /** Time an awaited block independently (safe under Promise.all). */
  async span<T>(stage: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      this.stages[stage] = (this.stages[stage] || 0) + (Date.now() - start);
    }
  }

  flag(key: string, value: boolean | number | string): void {
    this.flags[key] = value;
  }

  /** Emit the single structured log line. Never throws. */
  emit(route: string, extra: Record<string, unknown> = {}): void {
    try {
      const coldStart = containerIsCold;
      containerIsCold = false;
      console.info(
        '[perf]',
        JSON.stringify({
          route,
          totalMs: Date.now() - this.t0,
          coldStart,
          stages: this.stages,
          flags: this.flags,
          ...extra,
        }),
      );
    } catch {
      // instrumentation must never break the request
    }
  }
}

/** Fetch the trace the auth middleware attached to the event (if any). */
export function perfOf(event: any): PerfTrace | undefined {
  return event?.__perf instanceof PerfTrace ? event.__perf : undefined;
}
