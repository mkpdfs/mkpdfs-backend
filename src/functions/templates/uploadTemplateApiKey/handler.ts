import { middyfy } from '@libs/lambda';
import { apiKeyOnlyMiddleware } from '@libs/middleware/dualAuth';
import { subscriptionMiddleware } from '@libs/middleware/subscription';
import { usageTrackingMiddleware } from '@libs/middleware/usageTracking';
import { uploadTemplate } from '../uploadTemplate/handler';

// POST /v1/templates/upload — server-to-server (x-api-key). Same middleware chain
// as the JWT route, with apiKeyOnly swapped for iamOnly.
export const main = middyfy(uploadTemplate)
  .use(apiKeyOnlyMiddleware())
  .use(subscriptionMiddleware())
  .use(usageTrackingMiddleware({ actionType: 'template_upload' }));
