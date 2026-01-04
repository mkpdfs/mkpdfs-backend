import { ValidatedEventAPIGatewayProxyEvent, formatJSONResponse, formatErrorResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { iamOnlyMiddleware } from '@libs/middleware/dualAuth';
import { buildThumbnailUrl } from '@libs/thumbnailUrl';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});

const listTemplates: ValidatedEventAPIGatewayProxyEvent<null> = async (event) => {
  try {
    const userId = event.userId!;

    // Query templates for this user
    const result = await docClient.send(new QueryCommand({
      TableName: process.env.TEMPLATES_TABLE!,
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId
      }
    }));

    const templates = result.Items || [];

    // Find templates that came from marketplace
    const marketplaceIds = [...new Set(
      templates
        .filter(t => t.sourceMarketplaceId)
        .map(t => t.sourceMarketplaceId as string)
    )];

    // Lookup marketplace thumbnails if needed
    let thumbnailMap: Record<string, string | null> = {};

    if (marketplaceIds.length > 0) {
      const batchResult = await docClient.send(new BatchGetCommand({
        RequestItems: {
          [process.env.MARKETPLACE_TABLE!]: {
            Keys: marketplaceIds.map(id => ({ templateId: id })),
            ProjectionExpression: 'templateId, thumbnailKey'
          }
        }
      }));

      const mpTemplates = batchResult.Responses?.[process.env.MARKETPLACE_TABLE!] || [];
      for (const mp of mpTemplates) {
        thumbnailMap[mp.templateId] = buildThumbnailUrl(mp.thumbnailKey);
      }
    }

    // Add thumbnailUrl to templates
    const templatesWithThumbnails = await Promise.all(templates.map(async template => {
      let thumbnailUrl: string | null = null;

      if (template.thumbnailKey) {
        // User template with AI-generated thumbnail - generate presigned URL
        try {
          thumbnailUrl = await getSignedUrl(s3Client, new GetObjectCommand({
            Bucket: process.env.ASSETS_BUCKET!,
            Key: template.thumbnailKey
          }), { expiresIn: 7 * 24 * 60 * 60 }); // 7 days
        } catch {
          // Thumbnail may not exist anymore
          thumbnailUrl = null;
        }
      } else if (template.sourceMarketplaceId) {
        // Template from marketplace - use public URL
        thumbnailUrl = thumbnailMap[template.sourceMarketplaceId] || null;
      }

      return {
        ...template,
        thumbnailUrl
      };
    }));

    return formatJSONResponse({
      templates: templatesWithThumbnails
    });
  } catch (error) {
    console.error('Error listing templates:', error);
    return formatErrorResponse(error as Error);
  }
};

export const main = middyfy(listTemplates)
  .use(iamOnlyMiddleware());