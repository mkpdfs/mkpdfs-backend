import { formatJSONResponse, formatErrorResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { generateUserCode, generateDeviceCode } from '../codes';

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const RATE_LIMIT_MAX = 10;               // device starts per IP
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const CODE_TTL_SECONDS = 600;
const POLL_INTERVAL_SECONDS = 5;

async function checkAndBumpRateLimit(ip: string): Promise<boolean> {
  const now = Date.now();
  const key = { pk: `CLI_DEVICE#${ip}`, sk: 'start' };
  const existing = await docClient.send(new GetCommand({
    TableName: process.env.RATE_LIMIT_TABLE!, Key: key,
  }));
  const item = existing.Item;
  const needsReset = !item || item.windowStart < now - RATE_LIMIT_WINDOW_MS;
  if (!needsReset && item!.count >= RATE_LIMIT_MAX) return false;
  await docClient.send(new UpdateCommand({
    TableName: process.env.RATE_LIMIT_TABLE!, Key: key,
    UpdateExpression: needsReset
      ? 'SET #count = :one, windowStart = :now, #ttl = :ttl'
      : 'SET #count = #count + :one, #ttl = :ttl',
    ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
    ExpressionAttributeValues: needsReset
      ? { ':one': 1, ':now': now, ':ttl': Math.floor((now + RATE_LIMIT_WINDOW_MS) / 1000) }
      : { ':one': 1, ':ttl': Math.floor((now + RATE_LIMIT_WINDOW_MS) / 1000) },
  }));
  return true;
}

const startDeviceAuth = async (event: any) => {
  try {
    const ip = event.requestContext?.identity?.sourceIp || 'unknown';
    if (!(await checkAndBumpRateLimit(ip))) {
      return formatJSONResponse({ error: 'slow_down', message: 'Too many requests. Try again later.' }, 429);
    }

    const deviceCode = generateDeviceCode();
    const userCode = generateUserCode();   // collision chance ~n/1.1e12 within 10-min TTL: negligible
    const now = Date.now();

    await docClient.send(new PutCommand({
      TableName: process.env.CLI_AUTH_TABLE!,
      Item: {
        deviceCode, userCode,
        status: 'pending',
        createdAt: now,
        lastPolledAt: 0,
        ttl: Math.floor(now / 1000) + CODE_TTL_SECONDS,
      },
      ConditionExpression: 'attribute_not_exists(deviceCode)',
    }));

    const webBase = process.env.FRONTEND_URL!;
    return formatJSONResponse({
      deviceCode,
      userCode,
      verificationUri: `${webBase}/cli/authorize`,
      expiresIn: CODE_TTL_SECONDS,
      interval: POLL_INTERVAL_SECONDS,
    });
  } catch (error) {
    return formatErrorResponse(error);
  }
};

export const main = middyfy(startDeviceAuth);
