# mkpdfs API - Multi-User SaaS PDF Generation Service

A serverless API for multi-user PDF generation with template management, built on AWS Lambda.

## Architecture

- **Multi-User**: Each user has isolated templates and PDFs
- **Dual Authentication**: AWS IAM (web app) and API tokens (programmatic access)
- **Usage Tracking**: Per-user limits based on subscription tiers
- **Serverless**: Built with Serverless Framework and AWS Lambda

## Quick Start

### Prerequisites

1. AWS CLI configured with credentials
2. Node.js 20.x
3. Serverless Framework CLI: `npm install -g serverless`

### Installation

```bash
npm install

# Install Puppeteer layer dependencies
cd layers/puppeteer && npm install && cd ../..
```

### Local Development

```bash
# Run offline
npm run offline

# Type check
npm run typecheck
```

### Deployment

```bash
# Deploy to dev
npm run deploy:dev

# Deploy to production
npm run deploy:prod
```

## API Endpoints

### User Management (AWS_IAM only)
- `GET /user/profile` - Get user profile and subscription
- `GET /user/tokens` - List API tokens
- `POST /user/tokens` - Create new API token
- `DELETE /user/tokens/{tokenId}` - Delete API token
- `GET /user/usage` - Get usage statistics

### Template Management (AWS_IAM only)
- `GET /templates` - List user templates
- `POST /templates` - Upload new template
- `DELETE /templates/{templateId}` - Delete template

### PDF Generation (Dual auth - AWS_IAM or API token)
- `POST /pdf/generate` - Generate PDF synchronously
- `POST /pdf/generate-async` - Generate PDF asynchronously (legacy)

### Async Job API (Dual auth - AWS_IAM or API token)
- `POST /jobs/submit` - Submit async PDF generation job
- `GET /jobs/{jobId}` - Get job status

## Authentication

### Web Application (AWS_IAM)
Uses AWS Amplify with Cognito for authentication. Requests are automatically signed.

### API Access (Token)
Include API token in request header:
```
X-Api-Key: tlfy_your_token_here
```

## Usage Example

### Generate PDF with API Token

```bash
curl -X POST https://apis.mkpdfs.com/pdf/generate \
  -H "X-Api-Key: tlfy_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{
    "templateId": "invoice-001",
    "data": {
      "customerName": "John Doe",
      "amount": 100.00
    },
    "sendEmail": ["customer@example.com"]
  }'
```

## Async PDF Generation (Job API)

For large or complex PDFs that may timeout with synchronous generation, use the async job API. Jobs are processed via SQS with automatic retries and optional webhook notifications.

### Submit a Job

```bash
curl -X POST https://apis.mkpdfs.com/jobs/submit \
  -H "X-Api-Key: tlfy_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{
    "templateId": "invoice-001",
    "data": { "customerName": "John Doe", "amount": 100.00 },
    "webhookUrl": "https://your-server.com/webhook",
    "webhookSecret": "your-secret-for-signature-verification"
  }'
```

**Response (202 Accepted):**
```json
{
  "success": true,
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending",
  "statusUrl": "https://apis.mkpdfs.com/jobs/550e8400-e29b-41d4-a716-446655440000",
  "pageCount": 1,
  "message": "PDF generation job submitted successfully"
}
```

### Check Job Status

```bash
curl https://apis.mkpdfs.com/jobs/{jobId} \
  -H "X-Api-Key: tlfy_your_token_here"
```

**Response (completed):**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "templateId": "invoice-001",
  "pageCount": 1,
  "pdfUrl": "https://...",
  "sizeBytes": 125000,
  "createdAt": "2025-01-15T10:00:00.000Z",
  "completedAt": "2025-01-15T10:00:30.000Z",
  "expiresIn": "5 days"
}
```

**Job Statuses:**
- `pending` - Job queued, waiting to be processed
- `processing` - PDF generation in progress
- `completed` - PDF ready, `pdfUrl` available
- `failed` - Generation failed, `error` and `errorCode` available

### Webhook Notifications

If `webhookUrl` is provided, a POST request is sent on job completion or failure.

**Webhook Payload:**
```json
{
  "event": "job.completed",
  "timestamp": "2025-01-15T10:00:30.000Z",
  "data": {
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "completed",
    "pdfUrl": "https://...",
    "pageCount": 1,
    "sizeBytes": 125000,
    "createdAt": "2025-01-15T10:00:00.000Z",
    "completedAt": "2025-01-15T10:00:30.000Z"
  }
}
```

**Webhook Headers:**
- `X-Mkpdfs-Event`: `job.completed` or `job.failed`
- `X-Mkpdfs-Timestamp`: Unix timestamp
- `X-Mkpdfs-Signature`: `sha256=<HMAC-SHA256>` (if `webhookSecret` provided)

**Verifying Webhook Signatures (Node.js):**
```javascript
const crypto = require('crypto');

function verifyWebhook(payload, signature, timestamp, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex');
  return signature === `sha256=${expected}`;
}

// Usage
const isValid = verifyWebhook(
  req.body,                           // raw body string
  req.headers['x-mkpdfs-signature'],
  req.headers['x-mkpdfs-timestamp'],
  'your-webhook-secret'
);
```

**Webhook Retry Policy:**
- 3 attempts with exponential backoff (1s, 2s, 4s)
- Webhook failures don't affect job status
- Check `webhookStatus` in job response: `pending`, `delivered`, or `failed`

### Job Retention

Jobs are automatically deleted 7 days after completion via DynamoDB TTL.

## Subscription Tiers

- **Free**: 100 PDFs/month, 5 templates, 1 API token
- **Starter**: 1,000 PDFs/month, 50 templates, 3 API tokens
- **Professional**: 10,000 PDFs/month, 500 templates, 10 API tokens
- **Enterprise**: Unlimited

## Environment Variables

The following are automatically configured:
- `USERS_TABLE` - DynamoDB table for users
- `TOKENS_TABLE` - DynamoDB table for API tokens
- `USAGE_TABLE` - DynamoDB table for usage tracking
- `ASSETS_BUCKET` - S3 bucket for templates and PDFs
- `FROM_EMAIL` - SES verified email address

## Next Steps

1. **Configure SES**: Verify your domain/email in AWS SES
2. **Set up Cognito**: Configure Google OAuth in the Cognito User Pool
3. **Custom Domain**: Update `customDomain` in serverless.ts
4. **Deploy**: Run `npm run deploy:dev` to deploy

## Project Structure

```
mkpdfs-api/
├── src/
│   ├── functions/       # Lambda functions
│   ├── libs/           # Shared libraries
│   └── resources/      # AWS resource definitions
├── layers/
│   └── puppeteer/      # Chromium layer
├── serverless.ts       # Serverless configuration
└── package.json
```