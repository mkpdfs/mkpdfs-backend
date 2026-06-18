import { middyfy } from '@libs/lambda';
import { apiKeyOnlyMiddleware } from '@libs/middleware/dualAuth';
import { subscriptionMiddleware } from '@libs/middleware/subscription';
import { updateTemplate } from '../updateTemplate/handler';

// PUT /v1/templates/{templateId} — server-to-server (x-api-key).
export const main = middyfy(updateTemplate)
  .use(apiKeyOnlyMiddleware())
  .use(subscriptionMiddleware());
