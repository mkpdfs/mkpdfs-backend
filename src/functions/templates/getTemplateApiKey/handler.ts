import { middyfy } from '@libs/lambda';
import { apiKeyOnlyMiddleware } from '@libs/middleware/dualAuth';
import { getTemplate } from '../getTemplate/handler';

// GET /v1/templates/{templateId} — server-to-server (x-api-key).
export const main = middyfy(getTemplate).use(apiKeyOnlyMiddleware());
