import { ValidatedEventAPIGatewayProxyEvent, formatJSONResponse, formatErrorResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { iamOnlyMiddleware } from '@libs/middleware/dualAuth';
import { CREDITS_PER_PACK, DEFAULT_RECHARGE_THRESHOLD } from '@libs/creditConstants';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

interface UpdateAutoRechargeRequest {
  enabled: boolean;
  threshold?: number;
}

const handler: ValidatedEventAPIGatewayProxyEvent<UpdateAutoRechargeRequest> = async (event: any) => {
  try {
    const userId = event.userId!;
    const { enabled, threshold } = event.body || {};

    if (typeof enabled !== 'boolean') {
      return formatErrorResponse(new Error('enabled (boolean) is required'), 400);
    }
    // Cap at one pack: a threshold above CREDITS_PER_PACK would re-trigger a
    // $10 recharge after every single debit, forever
    if (threshold !== undefined && (!Number.isInteger(threshold) || threshold < 1 || threshold > CREDITS_PER_PACK)) {
      return formatErrorResponse(new Error(`threshold must be an integer between 1 and ${CREDITS_PER_PACK}`), 400);
    }

    const data = await docClient.send(new GetCommand({
      TableName: process.env.SUBSCRIPTIONS_TABLE!,
      Key: { userId },
    }));
    const billing = data.Item;

    // Strict update — never upsert a partial ghost row that would block the
    // subscription middleware's conditional seeding
    if (!billing) {
      return formatErrorResponse(new Error('No billing record yet'), 404);
    }

    if (enabled && !billing.stripePaymentMethodId) {
      return formatJSONResponse({
        success: false,
        error: 'NO_PAYMENT_METHOD',
        message: 'Buy a credit pack first so there is a saved card for auto-recharge.',
      }, 400);
    }

    const newThreshold =
      threshold ?? billing.rechargeThreshold ?? DEFAULT_RECHARGE_THRESHOLD;

    // Toggling either way acknowledges a past recharge failure — clear it
    await docClient.send(new UpdateCommand({
      TableName: process.env.SUBSCRIPTIONS_TABLE!,
      Key: { userId },
      UpdateExpression:
        'SET autoRecharge = :enabled, rechargeThreshold = :threshold, updatedAt = :now' +
        ' REMOVE autoRechargeError',
      ExpressionAttributeValues: {
        ':enabled': enabled,
        ':threshold': newThreshold,
        ':now': new Date().toISOString(),
      },
    }));

    return formatJSONResponse({
      success: true,
      autoRecharge: enabled,
      rechargeThreshold: newThreshold,
    });
  } catch (error) {
    console.error('Error updating auto-recharge:', error);
    return formatErrorResponse(error);
  }
};

export const main = middyfy(handler)
  .use(iamOnlyMiddleware());
