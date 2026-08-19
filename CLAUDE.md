# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

mkpdfs API (formerly Templify — the `tlfy_` token prefix survives) is a multi-user PDF generation SaaS on AWS Lambda: Handlebars templates + Puppeteer/Chromium, user isolation, usage tracking, subscription management.

**Infra = AWS CDK since 2026-06-11 (greenfield).** Serverless Framework is retired; `serverless.yml` and the `deploy:*/offline/remove:*` npm scripts are legacy. The CDK app lives in `cdk/` (5 stacks per env: Database/Storage/Auth/Jobs/Api). Full inventory and migration lessons: `docs/cdk-migration-plan.md`. Orchestrator-level summary: `../CLAUDE.md`.

## Development Commands

```bash
# Type checking (src + cdk)
npm run typecheck

# Diff / deploy (profile 'rocketeast'; --require-approval never already set)
npm run cdk:diff
npm run cdk:deploy:dev
npm run cdk:deploy:prod

# Lambda logs while iterating
aws logs tail /aws/lambda/<FunctionName> --follow --profile rocketeast
```

CI: push `dev` → CDK deploy dev; push `main` → CDK deploy prod (`.github/workflows/deploy.yml`, OIDC).

**Chromium layer**: referenced by ARN `arn:aws:lambda:us-east-1:197837191835:layer:mkpdfs-chromium:1` (official Sparticuz v143 artifact in `s3://mkpdfs-prod-bucket/lambda-layers/`); `puppeteer-core` is bundled by esbuild. Do NOT rebuild a local layer — to upgrade Chromium, publish a new layer version from a new S3 artifact and bump the ARN in `cdk/lib/service-function.ts`.

## Architecture

### Multi-User SaaS Design
- **User Isolation**: Each user has separate S3 prefix (`users/{userId}/`) and DynamoDB partition keys
- **Dual Authentication**: 
  - AWS_IAM (Cognito) for web applications
  - API tokens (`tlfy_` prefix) for programmatic access
- **Billing**: prepaid credits ($10 = 1,000 credits, 1 credit = 1 PDF page, never expire; 10 welcome credits on signup). Plans: `credits` (default) | `enterprise` (unlimited, manual). Monthly usage table is stats-only.
- **Credit gate**: `checkCreditsMiddleware` → 402; debit on HTTP 200 (`debitCreditsMiddleware`) or in the SQS job processor; opt-in auto-recharge via off-session Stripe PaymentIntent (see `src/libs/services/creditService.ts`)

### Lambda Functions

#### User Management (AWS_IAM only)
- `getUserProfile`: Returns user profile with subscription info
- `updateUserProfile`: Updates user settings
- `listUserTokens`: Lists user's API tokens
- `createUserToken`: Generates new API token (respects subscription limits)
- `deleteUserToken`: Revokes API token
- `getUserUsage`: Returns usage statistics for current month

#### Template Management (AWS_IAM only)
- `listUserTemplates`: Lists user's templates
- `uploadTemplate`: Uploads new template (validates subscription limits)
- `deleteTemplate`: Removes template

#### Template Management — headless `/v1/templates/*` (API-key only, added 2026-06-18, #2)
Server-to-server CRUD for CI, mirroring `/v1/pdf/generate`: NO Cognito Gateway authorizer,
`apiKeyOnlyMiddleware` (rejects `Authorization: Bearer`; only `x-api-key: tlfy_*`). Thin
wrapper handlers (`src/functions/templates/*ApiKey/`) reuse the JWT handler cores. Each fn
gets `grantDualAuth` (TOKENS_TABLE RW for `lastUsed`) PLUS its JWT sibling's grants
(least-privilege bucket: read list/get, put upload/update, delete). Routes: `GET /v1/templates`,
`GET|PUT|DELETE /v1/templates/{templateId}`, `POST /v1/templates/upload`. Consumed by the CLI's
`mkp templates … --api-key`. Token mint/revoke stays JWT-only (no privilege escalation); token
scopes deferred.

#### MCP server — `POST /v1/mcp` (API-key only; built 2026-07-03, actually SHIPPED 2026-07-11)

History gotcha: the feature sat on the `mcp-server` branch and was only ever deployed to dev
manually — subsequent dev pushes clobbered it while the landing already advertised the
endpoint. Merged + released (dev & prod) 2026-07-11.

Exposes `generate_pdf` + template CRUD (`list_templates`, `get_template`, `upload_template`,
`update_template`, `delete_template`) **plus `get_authoring_guide`** as
[MCP](https://modelcontextprotocol.io) tools, so external services/agents can drive mkpdfs
the same way the CLI does headlessly. Same posture as `/v1/pdf/generate` and
`/v1/templates/*`: no Gateway authorizer, `x-api-key: tlfy_*` only.

Agent-onboarding layer (`src/functions/mcp/authoringGuide.ts`): the server sends compact
`instructions` on initialize (template format primer) and `get_authoring_guide` returns the
full walkthrough — format, exact helper signatures, worked example — ported from the CLI's
embedded `mkp instructions --agent`. **Keep helper signatures in sync with `pdfService.ts`
and with `mkpdfs-cli/internal/cli/instr_format.md`.** Rationale: a real agent connected to
the bare CRUD tools and concluded templates "couldn't be parameterized" — the format
knowledge must travel with the server.

Each tool call builds a synthetic `APIGatewayProxyEvent` and invokes the matching `*ApiKey`
handler's exported `main` **in-process** (`src/functions/mcp/tools.ts` +
`invokeApiKeyHandler.ts`) — no network hop, and auth/credits/subscription/usage-tracking stay
guaranteed-identical to REST because it's literally the same code running. `generate_pdf` is
synchronous only (no `async`/`sendEmail`).

Transport: `@modelcontextprotocol/sdk`'s `WebStandardStreamableHTTPServerTransport`
(`server/webStandardStreamableHttp.js` — pure Fetch API `Request`/`Response`, no Node `http`
shim), stateless (`sessionIdGenerator: undefined`) — a fresh `McpServer` + transport pair is
built **per Lambda invocation** (the SDK throws if a stateless transport is reused across
requests). `McpFn` shares `GeneratePdfApiKeyFn`'s footprint (Chromium layer, 4096 MB, 30s
timeout) since `generate_pdf` can take the same render path.

#### PDF Generation (Dual auth)
- `generatePdf`: Sync PDF generation endpoint
- `generatePdfAsync`: Legacy async processor (deprecated)

#### Async Job API (Dual auth)
- `submitJob`: Submit async PDF job, returns jobId immediately
- `processJob`: SQS consumer that processes PDF generation
- `getJobStatus`: Get job status by jobId

#### AI Template Generation (AWS_IAM only, premium feature)
- `submitAIGeneration`: Submit async AI template generation job
- `processAIGeneration`: SQS consumer that calls Bedrock for template generation
- `getAIJobStatus`: Get AI job status by jobId
- `getAIImageUploadUrl`: Get presigned S3 URL for uploading reference images

### Core Services and Patterns

#### Authentication Middleware (`src/libs/middleware/dualAuth.ts`)
- Checks `X-Api-Key` header first if token auth is allowed
- Falls back to AWS_IAM authentication via `cognitoIdentityId`
- Validates and refreshes token last-used timestamp
- Attaches user info to request context

#### Subscription Middleware (`src/libs/middleware/subscription.ts`)
- Auto-creates the `credits` billing record for new users (`creditBalance: WELCOME_CREDITS`, conditional write — never clobbers a concurrent webhook credit)
- Validates status (missing status = active, for webhook-seeded rows)
- Attaches limits to request context:
  ```typescript
  type SubscriptionLimits = {
    templatesAllowed: number
    apiTokensAllowed: number
    maxPdfSizeMB: number
    aiGenerationsPerMonth: number  // fixed quota, needs creditBalance > 0
  }
  ```

#### Credits & Usage Middleware
- `checkCreditsMiddleware` (`src/libs/middleware/credits.ts`): pre-request 402 gate vs `creditBalance` (enterprise bypasses)
- `debitCreditsMiddleware`: post-request debit on HTTP 200 + auto-recharge trigger
- `usageTrackingMiddleware`: post-request monthly stats (never blocks)

#### PDF Service (`src/libs/services/pdfService.ts`)
- Template retrieval from S3
- Handlebars compilation with custom helpers
- Puppeteer PDF generation with Lambda layer
- S3 upload with 5-day pre-signed URLs
- Optional email delivery via SES

#### PDF Generation Performance (optimized 2026-06-18)

Render speed work applied (dev + prod). Render engine stays headless Chromium — a free-engine swap to WeasyPrint was evaluated and rejected (no `box-shadow`, partial grid/flex, and it breaks the "render arbitrary user/AI HTML/CSS" promise).

What's done:
- **Browser reuse**: `browserInstance` is a module-scope singleton reused across warm invocations (pages are closed, not the browser). `browserLaunch` promise coalesces concurrent launches so one invocation never spawns two Chromium processes.
- **Render wait**: `page.setContent(html, { waitUntil: 'load' })` (NOT `networkidle0` — that added a 500ms idle-quiet tail) followed by a bounded font wait `PdfService.waitForFonts` (`Promise.race(document.fonts.ready, FONT_WAIT_MS=2000)`) so a slow/unreachable font CDN can't stall the render.
- **Self-hosted fonts** (no network fetch at render time): `scripts/fetch-fonts.mjs` downloads the 8 theme font pairs' woff2 (latin + latin-ext subsets only) from Google and generates `src/libs/theme/generated/fontFaces.ts` (~4.4MB of base64 `@font-face` data: URIs). **Re-run `node scripts/fetch-fonts.mjs` whenever `fonts.ts` changes**, then re-seed the marketplace.
  - `buildThemeStyle.ts` injects a local `<style id="mkpdfs-fonts">@font-face…</style>` (only the selected pair) instead of the old Google `<link>`.
  - Marketplace templates (no theme row, so `buildThemeHead` doesn't run for them) use the `{{{mkpdfsFontFaces}}}` Handlebars helper — registered in BOTH `pdfService.ts` AND `scripts/generate-thumbnails.ts` (keep in sync). Their hardcoded remote `@import` was removed. **Changing a marketplace `.hbs` requires `seed-marketplace.ts <env>` to push it to S3.**
- **Logo cache**: `logoCache` (module-scope, keyed by `logoKey` which is UUID-per-upload, bounded) skips the S3 GET + base64 on every branded render.
- **`--font-render-hinting=none`** appended to the Chromium launch args.
- **Lambda memory 4096 MB** for `GeneratePdfFn` / `GeneratePdfApiKeyFn` / `ProcessJobFn` (Chromium render is CPU-bound; CPU scales with memory).

2026-07-11 perf-review pass (docs/pdf-generation-performance-review-2026-07-11.md; free items executed):
- **Per-stage instrumentation**: every sync PDF request emits ONE `[perf]` JSON log line (stages: auth/subscription/creditGate/templateRow/templateCompile/theme/browser/setContent/fontWait + composeMs/pdfPrintMs/s3Upload/presign/email/debit; flags: coldStart, browserReused, templateCacheHit, logoCacheHit; plus status/path/pageCount). Emitted from `debitCreditsMiddleware.after` (last billing step), trace threaded via `event.__perf` (`src/libs/perf.ts`). Query with Logs Insights filtering `[perf]` — separate cold/warm percentiles BEFORE buying provisioned concurrency.
- **Usage read removed from PDF routes**: `subscriptionMiddleware({ readUsage: false })` on generate/generateApiKey (usage is stats-only; consumers that need `event.currentUsage` — aiLimits, getProfile — keep the default).
- **`lastUsed` write throttled**: API-token activity refreshes at most once/hour (display metadata, not audit) — one DDB write less per api-key request.
- **Bundles minified, no shipped sourcemaps** (+ dropped `--enable-source-maps`): smaller ZIPs, faster cold start. Tradeoff: minified stack traces.
- **Puppeteer aligned with the Chromium 143 layer** (2026-07-12): puppeteer-core pinned to `24.35.0` — the LAST release supporting Chrome 143 (24.36+ targets 144; never cross without publishing a new layer). Verified with a pixel-level regression: the 9 mp-cert templates rendered on dev before/after were raster-identical (0 differing pixels).
- Still deferred from the review: lazy per-fontKey font loading, Lambda power tuning (use the new `[perf]` data), async usage bookkeeping.

Possible improvements (deferred — discuss at scale):
- **Output cache**: hash `userId+templateId+contentVersion+data+theme+logoKey+today` → reuse the S3 PDF on a cache hit (skip render). Only helps repeat traffic; net-cheaper than rendering. Include `today` because system params (`{{today/now/year}}`) make output date-dependent.
- **Cold start**: provisioned concurrency / SnapStart, smaller bundle (`minify`, drop source maps, dynamic-import Stripe). Deferred until there's traffic.
- **Persistent Chromium** (ECS/Fargate or Gotenberg) — removes cold start, same engine/fidelity, but always-on cost.
- **Async email**: move the SES send off the sync response path (via SQS) — it's off the common path today.
- **Font subsets**: only latin + latin-ext are self-hosted; non-Latin text (Cyrillic/Greek/…) falls back to system fonts. User/AI templates with their own Google Fonts `@import` still fetch remotely (bounded by `FONT_WAIT_MS`).
- **Do NOT** cache the DynamoDB template row: its `contentVersion` IS the Handlebars-cache invalidation key, and `invalidateTemplateCache` has no external callers — a TTL row cache would serve stale templates after edits.
- **Gotcha**: `scripts/generate-thumbnails.ts` does not register `mkpdfsLogo` (despite the "MUST stay identical" comment) — regenerating thumbnails for logo-using templates throws `Missing helper: "mkpdfsLogo"`.

#### Deterministic PDF bytes (2026-08-19)

Same content in ⇒ same bytes out. `src/libs/services/pdfDeterminism.ts` (`normalizePdfBytes`)
runs on every `page.pdf()` result inside `generatePdfFromHtml`, so consumers can verify a stored
PDF with a plain `sha256` instead of rasterising it.

- **What actually varied**: `/CreationDate` and `/ModDate` in the plain-text Info object — and
  nothing else. Measured empirically on Chromium **127 and 152**, five real templates (single
  page, 12-page array, self-hosted webfonts, embedded raster logo, inline SVG QR) plus a 75-page
  6.8 MB stress file: every pair of runs differed in exactly those two 14-digit stamps. Skia emits
  no `/ID`, no XMP `/Metadata`, deterministic font resource names and deterministic Flate streams.
- **How**: the 14 digits are overwritten in place with `FIXED_PDF_DATE` (`20000101000000`). Same
  length by construction ⇒ every xref offset stays valid and **every other byte is preserved bit
  for bit**. The Info dict is walked with a tiny tokenizer that skips literal/hex strings, so a
  date-looking sequence inside a user-controlled `/Title` can never be rewritten. A full pdf-lib
  load+save was rejected: it re-serialises the whole document — built from arbitrary customer
  HTML — for no gain over a ≤28-byte edit.
- **`/Producer` is deliberately NOT normalised.** It carries the Chromium milestone
  (`Skia/PDF m143`), so bumping the layer changes the hash — which is correct, because the raster
  can change with it. Downstream verifiers should re-baseline on a Chromium bump.
- **Fail-safe**: `normalizePdfBytes` never throws and never changes length; on any anomaly
  (not a PDF, `/Info` inside an object stream, odd date shape, unexpected byte moved) it returns
  the ORIGINAL buffer and `pdfService` logs `[pdfService] PDF metadata not normalized`. A render
  can never fail because of it. Post-write invariant: segmented `Buffer.compare` proves only the
  intended digits moved.
- **Cost**: median **0.10 ms** on a typical 0.2–0.3 MB PDF, **2.3 ms** on a 6.8 MB / 75-page one
  (< 0.5 % of render time); transient memory = one buffer copy. Timed as `pdfNormalizeMs` in the
  `[perf]` line.
- **Render-unchanged proof**: 11 real PDFs compared before/after with obra's
  `scripts/pdf-golden/content-comparator.mjs` (page count, exact MediaBox/CropBox via pdf-lib,
  canonical `pdftotext`, and per-page raw RGB sha256 at 150 dpi via `pdftoppm`) — all identical.
- **Tests**: `pdfDeterminism.test.ts`, incl. a committed pair of REAL Chromium 152 renders of the
  same HTML (`__fixtures__/chromium-run-{a,b}.pdf`) that hash differently raw and identically
  after normalisation — so CI keeps the guarantee honest without needing a browser.

### Database Schema (DynamoDB)

```typescript
// Users Table
{
  userId: string,      // PK
  email: string,       // GSI
  name: string,
  settings: object,
  createdAt: string,
  updatedAt: string
}

// Tokens Table
{
  token: string,       // PK (SHA256 hashed)
  userId: string,      // GSI
  tokenId: string,
  name: string,
  expiresAt?: number,  // TTL
  lastUsedAt?: string,
  createdAt: string
}

// Usage Table
{
  userId: string,      // PK
  yearMonth: string,   // SK (YYYY-MM)
  pdfCount: number,
  totalSizeMB: number,
  updatedAt: string
}

// Subscriptions Table
{
  userId: string,      // PK
  plan: 'free' | 'starter' | 'professional' | 'enterprise',
  status: 'active' | 'cancelled' | 'past_due',
  // ... other fields
}

// Templates Table
{
  userId: string,      // PK
  templateId: string,  // SK
  name: string,
  s3Key: string,
  createdAt: string
}

// Jobs Table (async PDF generation)
{
  jobId: string,       // PK (UUID)
  userId: string,      // GSI (userId-createdAt-index)
  status: 'pending' | 'processing' | 'completed' | 'failed',
  templateId: string,
  data: object,        // Template data for processing
  webhookUrl?: string,
  webhookSecret?: string,
  pdfUrl?: string,     // Set on completion
  pdfKey?: string,
  pageCount: number,
  sizeBytes?: number,
  error?: string,
  errorCode?: string,
  webhookStatus?: 'pending' | 'delivered' | 'failed',
  webhookAttempts: number,
  createdAt: string,
  completedAt?: string,
  ttl: number          // Auto-delete 7 days after completion
}
```

### Important Implementation Details

#### Token Generation
- Tokens use `tlfy_` prefix followed by 32 random bytes (base64url)
- Stored as SHA256 hash in DynamoDB
- Support optional expiration dates

#### PDF Generation Flow (Sync)
1. Validate user authentication and subscription
2. Retrieve template from S3 (`users/{userId}/templates/{templateId}`) — compiled-template + logo caches in front of S3
3. Compile with Handlebars and provided data; inject local `@font-face` (self-hosted, no remote fetch — see PDF Generation Performance)
4. Generate PDF using Puppeteer (reused Chromium browser, `waitUntil: 'load'` + bounded font wait)
5. Upload to S3 (`users/{userId}/pdfs/{pdfId}.pdf`)
6. Generate pre-signed URL (5-day expiry)
7. Optionally send email with attachment or link (based on size)

#### Async Job Flow
For large PDFs that may timeout, use the job-based async API:

1. **Submit** (`POST /jobs/submit`):
   - Validate request and webhook URL
   - Create job record in DynamoDB (status: `pending`)
   - Send message to SQS queue
   - Return jobId immediately (202 Accepted)

2. **Process** (SQS consumer):
   - Update job status to `processing`
   - Generate PDF using PdfService
   - Update job with pdfUrl, sizeBytes (status: `completed`)
   - Track usage (only on success)
   - Send webhook if configured (3 retries with exponential backoff)

3. **Poll** (`GET /jobs/{jobId}`):
   - Return job status and result
   - Only owner can access their jobs

**Key Files:**
- `src/functions/jobs/submit/handler.ts` - Job submission
- `src/functions/jobs/process/handler.ts` - SQS consumer
- `src/functions/jobs/getStatus/handler.ts` - Status endpoint
- `src/libs/services/webhookService.ts` - Webhook delivery with retry
- `src/resources/sqs.ts` - Queue definitions

**SQS Configuration:**
- Main queue: `mkpdfs-{stage}-pdf-generation`
- Dead letter queue: `mkpdfs-{stage}-pdf-generation-dlq`
- Visibility timeout: 6 minutes
- Max receive count: 3 (then moves to DLQ)

**Webhook Headers:**
- `X-Mkpdfs-Event`: `job.completed` or `job.failed`
- `X-Mkpdfs-Timestamp`: Unix timestamp
- `X-Mkpdfs-Signature`: `sha256=<HMAC-SHA256>` (if secret provided)

#### AI Template Generation (Async)
Premium feature for generating PDF templates using Claude AI via AWS Bedrock. Uses async job processing due to generation times of 30+ seconds.

**Endpoints:**
- `POST /ai/generate-template-async` - Submit AI generation job
- `GET /ai/jobs/{jobId}` - Poll job status
- `POST /ai/image-upload-url` - Get presigned URL for large image uploads

**Image Handling:**
Due to API Gateway's 1MB payload limit, images are handled in two ways:
1. **Small images (<500KB)**: Sent directly as base64 in request body
2. **Large images (>500KB)**: Uploaded to S3 first via presigned URL, then S3 key passed to API

**Flow:**
```
Frontend                          Backend                         AWS
   │                                 │                              │
   ├─[Image >500KB?]─────────────────┤                              │
   │  Yes: POST /ai/image-upload-url─┼──────────────────────────────┤
   │       ←── { uploadUrl, s3Key }──┤                              │
   │       PUT uploadUrl ────────────┼──────────────────────────────┼→ S3
   │                                 │                              │
   ├─POST /ai/generate-template-async┤                              │
   │  { prompt, imageS3Key }         │                              │
   │       ←── { jobId, status }─────┤                              │
   │                                 ├──SQS──────────────────────────┤
   │                                 │                              │
   ├─GET /ai/jobs/{jobId} (polling)──┤                              │
   │       ←── { status, template }──┤     processAIGeneration      │
   │                                 │     ├─Fetch image from S3────┼→ S3
   │                                 │     ├─Call Bedrock (Claude)──┼→ Bedrock
   │                                 │     └─Update DynamoDB────────┼→ DynamoDB
```

**Key Files:**
- `src/functions/ai/submitGeneration/handler.ts` - Job submission
- `src/functions/ai/processGeneration/handler.ts` - SQS consumer (calls Bedrock)
- `src/functions/ai/getStatus/handler.ts` - Job status polling
- `src/functions/ai/getImageUploadUrl/handler.ts` - Presigned URL for S3 uploads
- `src/libs/services/bedrockService.ts` - Claude AI integration

**DynamoDB Schema (AI Jobs Table):**
```typescript
// AI Jobs Table
{
  jobId: string,           // PK (UUID)
  userId: string,          // GSI (userId-createdAt-index)
  status: 'pending' | 'processing' | 'completed' | 'failed',
  prompt: string,
  hasImage: boolean,
  imageS3Key?: string,     // S3 key for uploaded reference image
  previousTemplate?: string,
  feedback?: string,
  template?: {             // Set on completion
    content: string,
    name: string,
    description: string
  },
  sampleData?: object,
  error?: string,
  errorCode?: string,
  createdAt: string,
  completedAt?: string,
  ttl: number              // Auto-delete 7 days after completion
}
```

**SQS Configuration:**
- Main queue: `mkpdfs-{stage}-ai-generation`
- Dead letter queue: `mkpdfs-{stage}-ai-generation-dlq`
- Visibility timeout: 10 minutes (AI generation takes 30-60 seconds)
- Max receive count: 2 (then moves to DLQ)

**S3 Image Storage:**
- Path: `users/{userId}/ai-images/{imageId}.{ext}`
- Supported formats: PNG, JPEG, WebP
- Max file size: 10MB
- Presigned URL expiry: 5 minutes

#### Environment Configuration
- Serverless Framework automatically generates table names and bucket names
- Environment variables injected into Lambda functions
- Stage-specific configuration (dev/prod)
- Custom domain support via Route53

#### Middleware Stack (Middy)
All handlers use standardized middleware (PDF generation chain shown):
```typescript
middyfy(handler)
  .use(dualAuthMiddleware())
  .use(subscriptionMiddleware())
  .use(checkCreditsMiddleware())
  .use(usageTrackingMiddleware({ actionType: 'pdf_generation' }))
  .use(debitCreditsMiddleware())
```

### Deployment Prerequisites

1. **AWS Services Setup**:
   - SES: Verify sending domain/email
   - Cognito: Configure User Pool with Google OAuth
   - Route53: Set up custom domain (optional)

2. **Chromium layer**: already published (`mkpdfs-chromium:1`); nothing to build locally.

3. **Environment Variables**:
   - `FROM_EMAIL`: SES verified email address
   - Everything else is wired by the CDK stacks (`cdk/lib/service-function.ts` buildCommonEnv)

### Testing

No local emulator (serverless-offline retired). Iterate against the dev env: `npm run cdk:deploy:dev` + `aws logs tail`. Secrets (Stripe, Google OAuth) come from SSM/Secrets Manager at runtime or synth time — see `src/libs/ssmParams.ts`.
- API available at http://localhost:3001