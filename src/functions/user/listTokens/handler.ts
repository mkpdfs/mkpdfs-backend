import { ValidatedEventAPIGatewayProxyEvent, formatJSONResponse, formatErrorResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { iamOnlyMiddleware } from '@libs/middleware/dualAuth';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const listTokens: ValidatedEventAPIGatewayProxyEvent<null> = async (event) => {
  try {
    const userId = event.userId!;

    // Query tokens for this user using the userId-index GSI
    const result = await docClient.send(new QueryCommand({
      TableName: process.env.TOKENS_TABLE!,
      IndexName: 'userId-index',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId
      },
      ProjectionExpression: 'tokenId, #n, keyHint, createdAt, lastUsed, usageCount',
      ExpressionAttributeNames: {
        '#n': 'name'
      }
    }));

    return formatJSONResponse({
      tokens: result.Items || []
    });
  } catch (error) {
    console.error('Error listing tokens:', error);
    return formatErrorResponse(error as Error);
  }
};

export const main = middyfy(listTokens)
  .use(iamOnlyMiddleware());