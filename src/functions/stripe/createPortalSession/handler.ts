import { ValidatedEventAPIGatewayProxyEvent, formatJSONResponse, formatErrorResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { iamOnlyMiddleware } from '@libs/middleware/dualAuth';
import { createPortalSession } from '@libs/services/stripeService';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const handler: ValidatedEventAPIGatewayProxyEvent<null> = async (event: any) => {
  try {
    const userId = event.userId!;

    // Get subscription to get Stripe customer ID
    const subscriptionData = await docClient.send(new GetCommand({
      TableName: process.env.SUBSCRIPTIONS_TABLE!,
      Key: { userId }
    }));

    const subscription = subscriptionData.Item;

    if (!subscription?.stripeCustomerId) {
      return formatErrorResponse(
        new Error('No active subscription found. Please subscribe to a plan first.'),
        400
      );
    }

    // Create portal session
    const session = await createPortalSession(subscription.stripeCustomerId);

    return formatJSONResponse({
      success: true,
      url: session.url,
    });

  } catch (error) {
    console.error('Error creating portal session:', error);
    return formatErrorResponse(error);
  }
};

export const main = middyfy(handler)
  .use(iamOnlyMiddleware());
