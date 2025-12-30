import { ValidatedEventAPIGatewayProxyEvent, formatJSONResponse, formatErrorResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { iamOnlyMiddleware } from '@libs/middleware/dualAuth';
import { createCheckoutSession, PLAN_TO_PRICE } from '@libs/services/stripeService';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

interface CheckoutRequest {
  plan: string;
}

const handler: ValidatedEventAPIGatewayProxyEvent<CheckoutRequest> = async (event: any) => {
  try {
    const userId = event.userId!;
    const { plan } = event.body || {};

    if (!plan) {
      return formatErrorResponse(new Error('Plan is required'), 400);
    }

    const priceId = PLAN_TO_PRICE[plan.toLowerCase()];
    if (!priceId) {
      return formatErrorResponse(new Error(`Invalid plan: ${plan}`), 400);
    }

    // Get user data to get email and existing Stripe customer ID
    const userData = await docClient.send(new GetCommand({
      TableName: process.env.USERS_TABLE!,
      Key: { userId }
    }));

    const user = userData.Item;
    if (!user) {
      return formatErrorResponse(new Error('User not found'), 404);
    }

    // Get subscription to check for existing Stripe customer
    const subscriptionData = await docClient.send(new GetCommand({
      TableName: process.env.SUBSCRIPTIONS_TABLE!,
      Key: { userId }
    }));

    const subscription = subscriptionData.Item;
    const stripeCustomerId = subscription?.stripeCustomerId;

    // Create checkout session
    const session = await createCheckoutSession({
      userId,
      userEmail: user.email,
      priceId,
      stripeCustomerId,
    });

    // If this is a new customer, save the customer ID
    if (!stripeCustomerId && session.customer) {
      await docClient.send(new UpdateCommand({
        TableName: process.env.SUBSCRIPTIONS_TABLE!,
        Key: { userId },
        UpdateExpression: 'SET stripeCustomerId = :customerId, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
          ':customerId': session.customer,
          ':updatedAt': new Date().toISOString(),
        }
      }));
    }

    return formatJSONResponse({
      success: true,
      url: session.url,
      sessionId: session.id,
    });

  } catch (error) {
    console.error('Error creating checkout session:', error);
    return formatErrorResponse(error);
  }
};

export const main = middyfy(handler)
  .use(iamOnlyMiddleware());
