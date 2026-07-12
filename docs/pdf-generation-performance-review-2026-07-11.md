# PDF Generation Performance Review

**Date:** 2026-07-11  
**Scope:** `mkpdfs-backend` PDF generation hot path

## Executive summary

The current architecture is solid. It already reuses Chromium on warm Lambda invocations, avoids `networkidle0`, bounds font waiting, self-hosts fonts, caches templates and logos, and assigns 4096 MB to the PDF functions.

The next gains are unlikely to come from replacing Chromium. The strongest opportunities are instrumentation, removing sequential DynamoDB work, reducing cold-start overhead, aligning browser dependencies, and selectively caching repeated outputs.

## Current hot path

A synchronous API-key request approximately performs:

1. Read the API token and update `lastUsed` in DynamoDB.
2. Read subscription and monthly usage.
3. Read the template row, plus template/logo objects on cache misses.
4. Compile Handlebars and compose HTML.
5. Start or reuse Chromium, load HTML, wait for fonts, and print.
6. Upload the PDF to S3 and create a presigned URL.
7. Update usage, debit credits, write the ledger, and potentially trigger auto-recharge.

Client-visible duration therefore includes substantially more than Chromium rendering.

## Recommendations

### 1. Instrument every stage

This is the highest-priority change. Emit one structured performance event per request containing:

- Auth and subscription time.
- Template row, template fetch/compile, and theme/logo time.
- HTML composition and browser acquisition time.
- Whether Chromium, template, and logo caches were reused.
- Page creation, `setContent`, font wait, and `page.pdf` time.
- S3 upload, presigning, usage update, and credit debit time.
- Total time, page count, and cold-start status.

Use CloudWatch Logs Insights to calculate cold and warm p50, p95, and p99 separately. Measurement should precede Provisioned Concurrency or a renderer migration.

### 2. Remove unnecessary synchronous DynamoDB work

`subscriptionMiddleware` reads monthly usage even though usage is now statistics-only and no longer gates PDF generation. Remove that read from PDF routes unless a downstream consumer actually needs `event.currentUsage`.

API-key auth also reads the token and synchronously updates `lastUsed` on every request. Keep the auth read, but update activity only when the stored value is older than an interval such as one hour.

After rendering, the response waits for usage, balance, ledger, and sometimes auto-recharge work. Usage statistics can move off the response path. Billing must remain durable; moving it asynchronously requires explicit idempotency and retry guarantees.

### 3. Align Puppeteer with Chromium 143

The deployed layer contains Chromium 143, while `puppeteer-core` 24.11.1 officially targets Chrome 138.

Test Puppeteer 24.32.0–24.35.0, whose supported browser versions belong to the Chrome 143 milestone. Do not jump to Puppeteer 25 without also updating and testing the Chromium layer.

Reference: [Puppeteer supported browsers](https://pptr.dev/supported-browsers)

Expected benefit is primarily compatibility and stability; do not assume a major speed increase without benchmarks.

### 4. Reduce cold-start and bundle overhead

The CDK bundle currently uses `minify: false` and `sourceMap: true`. The generated `fontFaces.ts` is also approximately 4.4 MB of base64 font data, forcing Node/V8 to load and parse every font pair during initialization.

Test independently:

1. Enable production minification.
2. Exclude source maps from deployed ZIPs while retaining CI artifacts if needed.
3. Place font files in the Lambda layer and load only the requested `fontKey`.
4. Cache loaded font CSS at module scope.
5. Compare ZIP size and Lambda `Init Duration` before and after each experiment.

Keep fonts local. Returning to a public CDN would exchange cold-start savings for unpredictable render-time latency.

### 5. Power-tune Lambda memory

The current 4096 MB allocation is reasonable because Lambda CPU scales with memory. Benchmark 3072, 4096, 6144, and 8192 MB, comparing both duration and GB-second cost.

Reference: [Configure Lambda function memory](https://docs.aws.amazon.com/lambda/latest/dg/configuration-memory.html)

### 6. Add output caching only for repeat traffic

An output cache can skip Handlebars, Chromium, and upload on a hit. It only helps if identical documents repeat.

An approximate key is:

```text
sha256(userId + templateId + contentVersion + canonicalJson(data) +
       themeVersion + logoKey + relevantSystemTime)
```

JSON must be canonicalized with sorted keys. Time bucketing must reflect the exact system helpers available to templates. Before implementation, define credit behavior, retention, sensitive-document handling, email reuse, and metrics. Recommended billing behavior: a cache hit still consumes credits because a PDF page is delivered.

### 7. Account for fragmented warm pools

`/pdf/generate`, `/v1/pdf/generate`, `/v1/mcp`, and async/SQS processing run in separate functions. Each has its own Chromium process and in-memory caches.

If traffic is split between them, warm-browser and cache hit rates decrease. Measure route distribution before consolidating; an additional Lambda invocation hop may outweigh the benefit.

### 8. Use Provisioned Concurrency only if cold starts dominate

Provisioned Concurrency provides initialized Lambda environments but adds continuous cost. Consider one provisioned environment on the primary production route only when cold starts materially affect p95/p99 or there is a strict latency SLA.

References:

- [Lambda execution environment lifecycle](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html)
- [Configuring Provisioned Concurrency](https://docs.aws.amazon.com/lambda/latest/dg/provisioned-concurrency.html)

### 9. Keep Chromium

Do not replace Chromium with WeasyPrint or wkhtmltopdf for arbitrary user- and AI-authored HTML/CSS. Chromium retains the best compatibility with modern layout, SVG, fonts, shadows, flexbox, and grid.

Gotenberg on ECS/Fargate would preserve Chromium fidelity and persistent browser capacity, but introduces always-on cost, network latency, container operations, and more monitoring surface. Revisit it only with sustained volume, strict latency requirements, or unfavorable Lambda economics.

## Implementation order

1. Add per-stage metrics and establish cold/warm p50, p95, and p99.
2. Remove the monthly usage read and throttle token `lastUsed` writes.
3. Upgrade Puppeteer within the Chromium-143-compatible 24.x range and run visual/E2E tests.
4. Minify production bundles, remove deployed source maps, and load fonts lazily.
5. Power-tune Lambda memory and remeasure.
6. Move noncritical usage bookkeeping off the response path.
7. Add output caching only if duplicate-request frequency justifies it.
8. Add Provisioned Concurrency only if cold starts remain dominant.
9. Evaluate Gotenberg/ECS only at sustained scale or under a strict SLA.

## Priority matrix

| Priority | Change | Expected benefit | Risk |
|---|---|---:|---:|
| P0 | Per-stage instrumentation | Enables every later decision | Low |
| P0 | Remove unused usage read | Lower every-request latency | Low |
| P1 | Throttle token activity writes | Lower API-key latency | Low–medium |
| P1 | Align Puppeteer and Chromium | Supported compatibility | Medium |
| P1 | Reduce bundle/font initialization | Lower cold-start latency | Medium |
| P1 | Lambda power tuning | Potentially faster and cheaper | Low |
| P2 | Async usage bookkeeping | Lower response latency | Medium |
