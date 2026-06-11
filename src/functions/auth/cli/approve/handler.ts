import { formatJSONResponse, formatErrorResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';
import { iamOnlyMiddleware } from '@libs/middleware/dualAuth';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { normalizeUserCode } from '../codes';

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const MAX_FAILED_LOOKUPS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const MAX_TOKEN_LENGTH = 8192;

async function bumpFailedLookups(userId: string): Promise<number> {
  const now = Date.now();
  const key = { pk: `CLI_APPROVE#${userId}`, sk: 'failed' };
  const ttl = Math.floor((now + LOCKOUT_WINDOW_MS) / 1000);

  // Atomic increment: concurrent failed lookups cannot lose updates, so the
  // cap is hard, not advisory.
  const result = await docClient.send(new UpdateCommand({
    TableName: process.env.RATE_LIMIT_TABLE!, Key: key,
    UpdateExpression: 'ADD #count :one SET #ttl = :ttl, windowStart = if_not_exists(windowStart, :now)',
    ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
    ExpressionAttributeValues: { ':one': 1, ':ttl': ttl, ':now': now },
    ReturnValues: 'UPDATED_NEW',
  }));

  const windowStart: number = result.Attributes?.windowStart ?? now;
  const count: number = result.Attributes?.count ?? 1;

  if (windowStart < now - LOCKOUT_WINDOW_MS) {
    // Window expired: reset counter. Rare path; conditional so concurrent
    // resets collapse to one — losing the race is benign (count stays ~1).
    try {
      await docClient.send(new UpdateCommand({
        TableName: process.env.RATE_LIMIT_TABLE!, Key: key,
        UpdateExpression: 'SET #count = :one, windowStart = :now, #ttl = :ttl',
        ConditionExpression: 'windowStart = :stale',
        ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':one': 1, ':now': now, ':ttl': ttl, ':stale': windowStart },
      }));
    } catch (error: any) {
      if (error?.name !== 'ConditionalCheckFailedException') throw error;
    }
    return 1;
  }

  return count;
}

// Advisory pre-check only — the atomic bump above is the enforcement record.
async function isLockedOut(userId: string): Promise<boolean> {
  const existing = await docClient.send(new GetCommand({
    TableName: process.env.RATE_LIMIT_TABLE!,
    Key: { pk: `CLI_APPROVE#${userId}`, sk: 'failed' },
  }));
  const item = existing.Item;
  return !!item && item.count >= MAX_FAILED_LOOKUPS && item.windowStart >= Date.now() - LOCKOUT_WINDOW_MS;
}

const approveDevice = async (event: any) => {
  try {
    const userId = event.userId!;
    const { userCode, action, tokens } = event.body ?? {};

    if (!userCode || !['approve', 'deny'].includes(action)) {
      return formatJSONResponse({ message: 'userCode and action (approve|deny) are required' }, 400);
    }
    if (action === 'approve' && !(tokens?.idToken && tokens?.accessToken && tokens?.refreshToken)) {
      return formatJSONResponse({ message: 'tokens {idToken, accessToken, refreshToken} required to approve' }, 400);
    }
    if (action === 'approve') {
      const fields = [tokens.idToken, tokens.accessToken, tokens.refreshToken];
      if (Object.keys(tokens).length !== 3 ||
          fields.some((f) => typeof f !== 'string' || f.length > MAX_TOKEN_LENGTH)) {
        return formatJSONResponse({ message: 'tokens must be exactly {idToken, accessToken, refreshToken} strings (max 8KB each)' }, 400);
      }
    }
    if (await isLockedOut(userId)) {
      return formatJSONResponse({ message: 'Too many failed attempts. Try again later.' }, 429);
    }

    const normalized = normalizeUserCode(userCode);
    const query = await docClient.send(new QueryCommand({
      TableName: process.env.CLI_AUTH_TABLE!,
      IndexName: 'userCode-index',
      KeyConditionExpression: 'userCode = :uc',
      ExpressionAttributeValues: { ':uc': normalized },
    }));

    const nowSec = Math.floor(Date.now() / 1000);
    const item = query.Items?.find((i) => i.status === 'pending' && i.ttl > nowSec);
    if (!item) {
      await bumpFailedLookups(userId);
      return formatJSONResponse({ message: 'Code not found or expired. Check your terminal.' }, 404);
    }

    // Atomic: only transitions a still-pending, unexpired code. Re-approval is rejected.
    await docClient.send(new UpdateCommand({
      TableName: process.env.CLI_AUTH_TABLE!,
      Key: { deviceCode: item.deviceCode },
      UpdateExpression: action === 'approve'
        ? 'SET #status = :new, userId = :uid, tokens = :tok, approvedAt = :now'
        : 'SET #status = :new, userId = :uid, approvedAt = :now',
      ConditionExpression: '#status = :pending AND #ttl > :nowSec',
      ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':new': action === 'approve' ? 'approved' : 'denied',
        ':pending': 'pending',
        ':uid': userId,
        ':nowSec': nowSec,
        ':now': Date.now(),
        // Whitelisted copy — never store the raw client-supplied object.
        ...(action === 'approve'
          ? { ':tok': { idToken: tokens.idToken, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken } }
          : {}),
      },
    }));

    return formatJSONResponse({ success: true, action });
  } catch (error: any) {
    if (error?.name === 'ConditionalCheckFailedException') {
      return formatJSONResponse({ message: 'Code already used or expired.' }, 409);
    }
    return formatErrorResponse(error);
  }
};

export const main = middyfy(approveDevice).use(iamOnlyMiddleware());
