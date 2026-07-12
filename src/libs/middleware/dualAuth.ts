import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'crypto';
import { decode } from 'jsonwebtoken';
import { PerfTrace } from '../perf';

// `lastUsed` is display metadata (dashboard "last used" column), not an audit
// trail — refreshing it at most once per hour drops one DynamoDB write from
// every API-key request (perf review 2026-07-11, P1).
const LAST_USED_REFRESH_MS = 60 * 60 * 1000;

interface JwtPayload {
  sub?: string;
  email?: string;
  name?: string;
}

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

interface DualAuthOptions {
  requireAuth?: boolean;
  allowApiToken?: boolean;
}

/**
 * Validates a raw API token (`tlfy_...`) against TOKENS_TABLE.
 *
 * Shared by dualAuthMiddleware and apiKeyOnlyMiddleware so the validation
 * logic lives in exactly one place:
 * - Tokens are stored SHA256-hashed (never raw), so we hash before lookup
 * - Token must exist, be `active`, and not be past `expiresAt` (if set)
 * - On success, refreshes the `lastUsed` timestamp
 *
 * @returns the owning userId, or null if the token is missing/inactive/expired
 */
export const validateApiToken = async (apiToken: string): Promise<string | null> => {
  try {
    // Hash the token for storage (we never store raw tokens)
    const hashedToken = createHash('sha256').update(apiToken).digest('hex');

    // Look up the token in DynamoDB
    const tokenData = await docClient.send(new GetCommand({
      TableName: process.env.TOKENS_TABLE!,
      Key: { token: hashedToken }
    }));

    // expiresAt is stored as an ISO string (createToken). The old comparison
    // `iso > Date.now()` coerced the string to NaN, so EVERY token with an
    // expiration failed validation from the moment it was created (backlog
    // bug, worse than documented). Parse to epoch; unparseable → fail closed.
    const expiresAtMs =
      tokenData.Item?.expiresAt == null
        ? null
        : typeof tokenData.Item.expiresAt === 'number'
          ? tokenData.Item.expiresAt
          : Date.parse(tokenData.Item.expiresAt);

    if (tokenData.Item && tokenData.Item.active && (expiresAtMs === null || expiresAtMs > Date.now())) {
      // Refresh last-used at most once per LAST_USED_REFRESH_MS
      const lastUsedAt = tokenData.Item.lastUsed ? Date.parse(tokenData.Item.lastUsed) : 0;
      if (!lastUsedAt || Date.now() - lastUsedAt > LAST_USED_REFRESH_MS) {
        await docClient.send(new UpdateCommand({
          TableName: process.env.TOKENS_TABLE!,
          Key: { token: hashedToken },
          UpdateExpression: 'SET lastUsed = :now',
          ExpressionAttributeValues: {
            ':now': new Date().toISOString()
          }
        }));
      }

      return tokenData.Item.userId;
    }

    return null;
  } catch (error) {
    console.error('Error validating API token:', error);
    return null;
  }
};

const unauthorizedResponse = (message: string) => ({
  statusCode: 401,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Credentials': true,
  },
  body: JSON.stringify({ message })
});

export const dualAuthMiddleware = (options: DualAuthOptions = { requireAuth: true, allowApiToken: true }) => {
  return {
    before: async (handler: any): Promise<any> => {
      handler.event.__perf = new PerfTrace();
      let userId: string | undefined;
      let userEmail: string | undefined;

      // First, try to extract user info from JWT Bearer token
      // This is the primary auth method for web clients and works in offline mode
      const authHeader = handler.event.headers?.['Authorization'] ||
                         handler.event.headers?.['authorization'];

      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        try {
          const decoded = decode(token) as JwtPayload;
          if (decoded?.sub) {
            userId = decoded.sub;
            userEmail = decoded.email;
          }
        } catch (e) {
          console.warn('Failed to decode JWT:', e);
        }
      }
      
      // Check for API token if allowed and no JWT userId found
      if (!userId && options.allowApiToken) {
        const apiToken = handler.event.headers?.['x-api-key'] || handler.event.headers?.['X-Api-Key'];

        if (apiToken) {
          const tokenUserId = await validateApiToken(apiToken);
          if (tokenUserId) {
            userId = tokenUserId;
          }
        }
      }
      
      // If no valid API token, check for AWS IAM authentication
      if (!userId) {
        // The cognitoIdentityId is set by API Gateway when using AWS_IAM authorizer
        userId = handler.event.requestContext?.identity?.cognitoIdentityId;
      }
      
      // Check if authentication is required
      if (options.requireAuth && !userId) {
        return {
          statusCode: 401,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Credentials': true,
          },
          body: JSON.stringify({
            message: 'Unauthorized: Valid authentication required'
          })
        };
      }
      
      // Attach userId and userEmail to event for downstream use
      if (userId) {
        handler.event.userId = userId;
      }
      if (userEmail) {
        handler.event.userEmail = userEmail;
      }
      handler.event.__perf.mark('auth');
    }
  };
};

// Middleware for AWS_IAM only endpoints
export const iamOnlyMiddleware = () => {
  return dualAuthMiddleware({ requireAuth: true, allowApiToken: false });
};

/**
 * Middleware for server-to-server routes that have NO API Gateway authorizer
 * (e.g. POST /v1/pdf/generate). Authentication is API token ONLY.
 *
 * SECURITY: this middleware deliberately does NOT accept `Authorization: Bearer`
 * JWTs. dualAuthMiddleware decodes JWTs with `decode()` — i.e. WITHOUT verifying
 * the signature — because on Cognito-protected routes API Gateway already
 * verified it. On a route without a Gateway authorizer, accepting a Bearer
 * token here would let anyone forge a JWT with an arbitrary `sub` and
 * impersonate any user. Only `x-api-key: tlfy_*` tokens (validated against
 * TOKENS_TABLE via SHA256 hash) are accepted.
 *
 * On success it sets `event.userId` exactly like dualAuthMiddleware, so the
 * downstream subscription/usage middlewares work unchanged.
 */
export const apiKeyOnlyMiddleware = () => {
  return {
    before: async (handler: any): Promise<any> => {
      handler.event.__perf = new PerfTrace();
      const apiToken = handler.event.headers?.['x-api-key'] || handler.event.headers?.['X-Api-Key'];

      if (!apiToken) {
        // No x-api-key → 401. Bearer-only requests land here on purpose (see note above).
        return unauthorizedResponse('Unauthorized: x-api-key header with a valid API token is required');
      }

      if (typeof apiToken !== 'string' || !apiToken.startsWith('tlfy_')) {
        return unauthorizedResponse('Unauthorized: invalid API token format');
      }

      const userId = await validateApiToken(apiToken);

      if (!userId) {
        return unauthorizedResponse('Unauthorized: invalid, inactive or expired API token');
      }

      // Same contract as dualAuthMiddleware: downstream middlewares read event.userId
      handler.event.userId = userId;
      handler.event.__perf.mark('auth');
    }
  };
};