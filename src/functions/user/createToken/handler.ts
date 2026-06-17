import { ValidatedEventAPIGatewayProxyEvent, formatJSONResponse, formatErrorResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { iamOnlyMiddleware } from '@libs/middleware/dualAuth';
import { subscriptionMiddleware } from '@libs/middleware/subscription';
import { usageTrackingMiddleware } from '@libs/middleware/usageTracking';
import { randomBytes, createHash } from 'crypto';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

interface CreateTokenRequest {
  name: string;
  expiresInDays?: number;
}

const createUserToken: ValidatedEventAPIGatewayProxyEvent<CreateTokenRequest> = async (event: any) => {
  try {
    const userId = event.userId!;
    const { name, expiresInDays } = event.body;
    
    // Check token limit based on subscription
    const limits = event.subscriptionLimits!;
    if (limits.apiTokensAllowed !== -1) {
      // Count existing tokens
      const existingTokens = await docClient.send(new QueryCommand({
        TableName: process.env.TOKENS_TABLE!,
        IndexName: 'userId-index',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: {
          ':userId': userId
        }
      }));
      
      const activeTokens = (existingTokens.Items || []).filter(token => token.active);
      
      if (activeTokens.length >= limits.apiTokensAllowed) {
        return formatJSONResponse({
          success: false,
          message: `Token limit reached. Your ${event.subscription!.plan} plan allows ${limits.apiTokensAllowed} API tokens.`
        }, 403);
      }
    }
    
    // Generate a secure random token
    const rawToken = `tlfy_${randomBytes(32).toString('hex')}`;
    const hashedToken = createHash('sha256').update(rawToken).digest('hex');
    const tokenId = randomBytes(8).toString('hex'); // Short ID for user-facing operations
    // Non-sensitive recognizable hint (prefix + last 4) so users can tell keys apart
    // in the dashboard. The secret itself is never stored (only its hash).
    const keyHint = `${rawToken.slice(0, 11)}…${rawToken.slice(-4)}`;

    // Calculate expiration
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null;

    // Save token to database
    const tokenData = {
      token: hashedToken,
      tokenId,
      keyHint,
      userId,
      name,
      active: true,
      createdAt: new Date().toISOString(),
      lastUsed: null,
      expiresAt
    };
    
    await docClient.send(new PutCommand({
      TableName: process.env.TOKENS_TABLE!,
      Item: tokenData
    }));
    
    return formatJSONResponse({
      success: true,
      data: {
        token: rawToken, // Return the raw token only once
        name,
        expiresAt,
        message: 'Store this token securely. It cannot be retrieved again.'
      }
    });
    
  } catch (error) {
    return formatErrorResponse(error);
  }
};

export const main = middyfy(createUserToken)
  .use(iamOnlyMiddleware())
  .use(subscriptionMiddleware())
  .use(usageTrackingMiddleware({ actionType: 'token_creation' }));