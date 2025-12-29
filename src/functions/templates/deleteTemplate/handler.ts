import { ValidatedEventAPIGatewayProxyEvent, formatJSONResponse, formatErrorResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { iamOnlyMiddleware } from '@libs/middleware/dualAuth';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});

const deleteTemplate: ValidatedEventAPIGatewayProxyEvent<null> = async (event) => {
  try {
    const userId = event.userId!;
    const templateId = event.pathParameters?.templateId;

    if (!templateId) {
      return formatJSONResponse({ message: 'Template ID is required' }, 400);
    }

    // First, verify the template exists and belongs to this user
    const existingTemplate = await docClient.send(new GetCommand({
      TableName: process.env.TEMPLATES_TABLE!,
      Key: {
        userId,
        templateId
      }
    }));

    if (!existingTemplate.Item) {
      return formatJSONResponse({ message: 'Template not found' }, 404);
    }

    const template = existingTemplate.Item;

    // Delete from S3
    const s3Key = template.s3Key || `${userId}/templates/${templateId}.hbs`;
    try {
      await s3Client.send(new DeleteObjectCommand({
        Bucket: process.env.ASSETS_BUCKET!,
        Key: s3Key
      }));
    } catch (s3Error: any) {
      // Log but don't fail if S3 delete fails (file might not exist)
      console.warn('Failed to delete template from S3:', s3Error.message);
    }

    // Delete from DynamoDB
    await docClient.send(new DeleteCommand({
      TableName: process.env.TEMPLATES_TABLE!,
      Key: {
        userId,
        templateId
      }
    }));

    return formatJSONResponse({
      message: 'Template deleted successfully',
      templateId
    });
  } catch (error) {
    console.error('Error deleting template:', error);
    return formatErrorResponse(error as Error);
  }
};

export const main = middyfy(deleteTemplate)
  .use(iamOnlyMiddleware());
