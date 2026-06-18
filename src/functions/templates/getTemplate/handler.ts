import { ValidatedEventAPIGatewayProxyEvent, formatJSONResponse, formatErrorResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { iamOnlyMiddleware } from '@libs/middleware/dualAuth';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});

export const getTemplate: ValidatedEventAPIGatewayProxyEvent<null> = async (event) => {
  try {
    const userId = event.userId!;
    const templateId = event.pathParameters?.templateId;

    if (!templateId) {
      return formatJSONResponse({ message: 'Template ID is required' }, 400);
    }

    // Get template metadata
    const result = await docClient.send(new GetCommand({
      TableName: process.env.TEMPLATES_TABLE!,
      Key: {
        userId,
        templateId
      }
    }));

    if (!result.Item) {
      return formatJSONResponse({ message: 'Template not found' }, 404);
    }

    const template = result.Item;

    // Get template content from S3
    const s3Key = template.s3Key || `${userId}/templates/${templateId}.hbs`;
    const s3Response = await s3Client.send(new GetObjectCommand({
      Bucket: process.env.ASSETS_BUCKET!,
      Key: s3Key
    }));

    const content = await s3Response.Body?.transformToString('utf-8');

    return formatJSONResponse({
      template: {
        ...template,
        content
      }
    });
  } catch (error) {
    console.error('Error getting template:', error);
    return formatErrorResponse(error as Error);
  }
};

export const main = middyfy(getTemplate)
  .use(iamOnlyMiddleware());
