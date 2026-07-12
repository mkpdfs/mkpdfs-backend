import { middyfy } from '@libs/lambda';
import { apiKeyOnlyMiddleware } from '@libs/middleware/dualAuth';
import { subscriptionMiddleware } from '@libs/middleware/subscription';
import { usageTrackingMiddleware } from '@libs/middleware/usageTracking';
import { checkCreditsMiddleware, debitCreditsMiddleware } from '@libs/middleware/credits';
import { generatePdf } from '../generate/handler';

/**
 * POST /v1/pdf/generate — server-to-server PDF generation.
 *
 * Same business logic as POST /pdf/generate (the handler is reused, not
 * duplicated), but this route has NO API Gateway authorizer: authentication
 * happens entirely in-lambda via apiKeyOnlyMiddleware, which ONLY accepts
 * `x-api-key: tlfy_*` tokens (Bearer JWTs are rejected — see dualAuth.ts).
 *
 * The subscription/credits/usage middleware chain is identical (same order)
 * to the original route; apiKeyOnlyMiddleware sets event.userId just like
 * dualAuthMiddleware, so they work unchanged.
 */
export const main = middyfy(generatePdf)
  .use(apiKeyOnlyMiddleware())
  // readUsage: false — usage is stats-only, never gates PDFs (perf review P0)
  .use(subscriptionMiddleware({ readUsage: false }))
  .use(checkCreditsMiddleware())
  .use(usageTrackingMiddleware({ actionType: 'pdf_generation' }))
  .use(debitCreditsMiddleware());
