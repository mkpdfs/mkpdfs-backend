# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Templify API is a multi-user SaaS version of the PDF generation service. It's a serverless API built on AWS Lambda that provides PDF generation from HTML templates using Handlebars and Puppeteer, with user isolation, usage tracking, and subscription management.

## Development Commands

```bash
# Type checking
npm run typecheck

# Local development with serverless-offline
npm run offline

# Deployment (uses 'rocketeast' AWS profile)
npm run deploy:dev
npm run deploy:prod

# Remove deployment
npm run remove:dev
npm run remove:prod

# View deployment info
npm run info:dev
npm run info:prod

# View Lambda logs (requires $FUNCTION env var)
FUNCTION=generatePdf npm run logs

# Test a function locally
npx sls invoke local -f generatePdf --path test/mock.json

# Layer setup (required before first deployment)
cd layers/puppeteer && npm install && cd ../..
```

## Architecture

### Multi-User SaaS Design
- **User Isolation**: Each user has separate S3 prefix (`users/{userId}/`) and DynamoDB partition keys
- **Dual Authentication**: 
  - AWS_IAM (Cognito) for web applications
  - API tokens (`tlfy_` prefix) for programmatic access
- **Usage Tracking**: Monthly usage tracked per user with subscription limits
- **Subscription Tiers**: Free, Starter, Professional, Enterprise

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

#### PDF Generation (Dual auth)
- `generatePdf`: Sync PDF generation endpoint
- `generatePdfAsync`: Legacy async processor (deprecated)

#### Async Job API (Dual auth)
- `submitJob`: Submit async PDF job, returns jobId immediately
- `processJob`: SQS consumer that processes PDF generation
- `getJobStatus`: Get job status by jobId

### Core Services and Patterns

#### Authentication Middleware (`src/libs/middleware/dualAuth.ts`)
- Checks `X-Api-Key` header first if token auth is allowed
- Falls back to AWS_IAM authentication via `cognitoIdentityId`
- Validates and refreshes token last-used timestamp
- Attaches user info to request context

#### Subscription Middleware (`src/libs/middleware/subscription.ts`)
- Auto-creates free tier subscription for new users
- Validates subscription status
- Attaches limits to request context:
  ```typescript
  type SubscriptionLimits = {
    maxPdfsPerMonth: number
    maxTemplates: number
    maxApiTokens: number
    maxPdfSizeMB: number
  }
  ```

#### Usage Tracking Middleware
- `checkLimitsMiddleware`: Pre-request validation against subscription limits
- `usageTrackingMiddleware`: Post-request usage recording
- Tracks: PDF count, total size, template count, token count

#### PDF Service (`src/libs/services/pdfService.ts`)
- Template retrieval from S3
- Handlebars compilation with custom helpers
- Puppeteer PDF generation with Lambda layer
- S3 upload with 5-day pre-signed URLs
- Optional email delivery via SES

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
2. Retrieve template from S3 (`users/{userId}/templates/{templateId}`)
3. Compile with Handlebars and provided data
4. Generate PDF using Puppeteer (Chromium layer)
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

#### Environment Configuration
- Serverless Framework automatically generates table names and bucket names
- Environment variables injected into Lambda functions
- Stage-specific configuration (dev/prod)
- Custom domain support via Route53

#### Middleware Stack (Middy)
All handlers use standardized middleware:
```typescript
middy(handler)
  .use(errorHandler())
  .use(httpJsonBodyParser())
  .use(dualAuthMiddleware({ allowToken: true }))
  .use(subscriptionMiddleware())
  .use(checkLimitsMiddleware({ resource: 'pdf' }))
  .use(usageTrackingMiddleware({ operation: 'generatePdf' }))
```

### Deployment Prerequisites

1. **AWS Services Setup**:
   - SES: Verify sending domain/email
   - Cognito: Configure User Pool with Google OAuth
   - Route53: Set up custom domain (optional)

2. **Layer Dependencies**:
   ```bash
   cd layers/puppeteer && npm install
   ```

3. **Environment Variables**:
   - `FROM_EMAIL`: SES verified email address
   - All other variables auto-generated by Serverless

### Testing Locally

For local development with serverless-offline:
- DynamoDB tables are mocked in-memory
- S3 operations use local file system
- Chromium path set via `CHROMIUM_PATH` env var
- API available at http://localhost:3001