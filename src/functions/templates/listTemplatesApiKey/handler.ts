import { middyfy } from '@libs/lambda';
import { apiKeyOnlyMiddleware } from '@libs/middleware/dualAuth';
import { listTemplates } from '../listTemplates/handler';

// GET /v1/templates — server-to-server (x-api-key). Reuses the JWT core; auth is
// in-lambda via apiKeyOnlyMiddleware (Bearer rejected — see dualAuth.ts).
export const main = middyfy(listTemplates).use(apiKeyOnlyMiddleware());
