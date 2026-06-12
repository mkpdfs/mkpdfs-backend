import { ValidatedEventAPIGatewayProxyEvent, formatJSONResponse, formatErrorResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { iamOnlyMiddleware } from '@libs/middleware/dualAuth';
import { createCheckoutSession } from '@libs/services/stripeService';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const handler: ValidatedEventAPIGatewayProxyEvent<null> = async (event: any) => {
  try {
    const userId = event.userId!;

    const userData = await docClient.send(new GetCommand({
      TableName: process.env.USERS_TABLE!,
      Key: { userId }
    }));

    const user = userData.Item;
    if (!user) {
      return formatErrorResponse(new Error('User not found'), 404);
    }

    const subscriptionData = await docClient.send(new GetCommand({
      TableName: process.env.SUBSCRIPTIONS_TABLE!,
      Key: { userId }
    }));

    const stripeCustomerId = subscriptionData.Item?.stripeCustomerId;

    const session = await createCheckoutSession({
      userId,
      userEmail: user.email,
      stripeCustomerId,
    });

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
