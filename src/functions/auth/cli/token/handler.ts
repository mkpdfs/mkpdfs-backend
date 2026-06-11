import { formatJSONResponse, formatErrorResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const MIN_POLL_MS = 5000;

const pollToken = async (event: any) => {
  try {
    const { deviceCode } = event.body ?? {};
    if (!deviceCode || typeof deviceCode !== 'string') {
      return formatJSONResponse({ error: 'invalid_request' }, 400);
    }

    const result = await docClient.send(new GetCommand({
      TableName: process.env.CLI_AUTH_TABLE!,
      Key: { deviceCode },
    }));
    const item = result.Item;
    const now = Date.now();

    if (!item || item.ttl <= Math.floor(now / 1000)) {
      return formatJSONResponse({ error: 'expired_token' }, 400);
    }

    if (now - (item.lastPolledAt ?? 0) < MIN_POLL_MS) {
      return formatJSONResponse({ error: 'slow_down' }, 429);
    }
    await docClient.send(new UpdateCommand({
      TableName: process.env.CLI_AUTH_TABLE!,
      Key: { deviceCode },
      UpdateExpression: 'SET lastPolledAt = :now',
      ExpressionAttributeValues: { ':now': now },
    }));

    if (item.status === 'pending') {
      return formatJSONResponse({ error: 'authorization_pending' }, 400);
    }
    if (item.status === 'denied') {
      await docClient.send(new DeleteCommand({
        TableName: process.env.CLI_AUTH_TABLE!, Key: { deviceCode },
      }));
      return formatJSONResponse({ error: 'access_denied' }, 400);
    }

    // approved → one-time atomic read-and-delete
    const deleted = await docClient.send(new DeleteCommand({
      TableName: process.env.CLI_AUTH_TABLE!,
      Key: { deviceCode },
      ConditionExpression: '#status = :approved',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':approved': 'approved' },
      ReturnValues: 'ALL_OLD',
    }));
    const tokens = deleted.Attributes?.tokens;
    if (!tokens) {
      return formatJSONResponse({ error: 'expired_token' }, 400);
    }

    return formatJSONResponse({
      idToken: tokens.idToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenType: 'Bearer',
    });
  } catch (error: any) {
    if (error?.name === 'ConditionalCheckFailedException') {
      return formatJSONResponse({ error: 'expired_token' }, 400);
    }
    return formatErrorResponse(error);
  }
};

export const main = middyfy(pollToken);
