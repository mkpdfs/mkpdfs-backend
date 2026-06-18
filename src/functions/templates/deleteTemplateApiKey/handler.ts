import { middyfy } from '@libs/lambda';
import { apiKeyOnlyMiddleware } from '@libs/middleware/dualAuth';
import { deleteTemplate } from '../deleteTemplate/handler';

// DELETE /v1/templates/{templateId} — server-to-server (x-api-key).
export const main = middyfy(deleteTemplate).use(apiKeyOnlyMiddleware());
