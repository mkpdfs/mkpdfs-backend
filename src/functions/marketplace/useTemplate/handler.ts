import { ValidatedEventAPIGatewayProxyEvent, formatJSONResponse, formatErrorResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, CopyObjectCommand } from '@aws-sdk/client-s3';
import { iamOnlyMiddleware } from '@libs/middleware/dualAuth';
import { subscriptionMiddleware } from '@libs/middleware/subscription';
import { v4 as uuidv4 } from 'uuid';
import { resolveThemeInput } from '@libs/theme/resolveLogoInput';
import { ThemeInput } from '@libs/theme/themeTypes';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});

const useTemplate: ValidatedEventAPIGatewayProxyEvent<null> = async (event: any) => {
  try {
    const userId = event.userId!;
    const subscriptionLimits = event.subscriptionLimits;
    const templateId = event.pathParameters?.templateId;

    if (!templateId) {
      return formatJSONResponse({ message: 'Template ID is required' }, 400);
    }

    const input = typeof event.body === 'string' ? JSON.parse(event.body || '{}') : (event.body || {});
    let theme;
    if (input.theme) {
      try {
        theme = await resolveThemeInput(userId, input.theme as ThemeInput);
      } catch (err: any) {
        if (err?.name === 'ThemeValidationError' || err?.name === 'LogoIngestError') {
          return formatJSONResponse({ message: err.message }, 400);
        }
        throw err;
      }
    }

    // Get marketplace template
    const mpResult = await docClient.send(new GetCommand({
      TableName: process.env.MARKETPLACE_TABLE!,
      Key: { templateId }
    }));

    if (!mpResult.Item) {
      return formatJSONResponse({ message: 'Marketplace template not found' }, 404);
    }

    const mpTemplate = mpResult.Item;

    // Check user's template limit
    if (subscriptionLimits) {
      const existingTemplates = await docClient.send(new QueryCommand({
        TableName: process.env.TEMPLATES_TABLE!,
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
        Select: 'COUNT'
      }));

      const currentCount = existingTemplates.Count || 0;

      if (subscriptionLimits.templatesAllowed !== -1 && currentCount >= subscriptionLimits.templatesAllowed) {
        return formatJSONResponse({
          message: `Template limit reached. Your plan allows ${subscriptionLimits.templatesAllowed} templates.`,
          currentCount,
          limit: subscriptionLimits.templatesAllowed
        }, 429);
      }
    }

    // Generate new template ID for user's copy
    const newTemplateId = uuidv4();
    const newS3Key = `${userId}/templates/${newTemplateId}.hbs`;
    const now = new Date().toISOString();

    // Copy template from marketplace to user's folder
    const copyResult = await s3Client.send(new CopyObjectCommand({
      Bucket: process.env.ASSETS_BUCKET!,
      CopySource: `${process.env.ASSETS_BUCKET}/${mpTemplate.s3Key}`,
      Key: newS3Key,
      ContentType: 'text/x-handlebars-template',
      Metadata: {
        userId,
        templateName: mpTemplate.name,
        sourceMarketplaceId: templateId,
        uploadedAt: now
      },
      MetadataDirective: 'REPLACE'
    }));

    // Create user template record
    const userTemplate = {
      userId,
      templateId: newTemplateId,
      id: newTemplateId,
      name: mpTemplate.name,
      description: mpTemplate.description || '',
      s3Key: newS3Key,
      sourceMarketplaceId: templateId,
      contentVersion: copyResult.VersionId || now,
      ...(theme ? { theme } : {}),
      createdAt: now,
      updatedAt: now
    };

    await docClient.send(new PutCommand({
      TableName: process.env.TEMPLATES_TABLE!,
      Item: userTemplate
    }));

    // Increment popularity counter on marketplace template
    await docClient.send(new UpdateCommand({
      TableName: process.env.MARKETPLACE_TABLE!,
      Key: { templateId },
      UpdateExpression: 'SET popularity = if_not_exists(popularity, :zero) + :inc',
      ExpressionAttributeValues: {
        ':zero': 0,
        ':inc': 1
      }
    }));

    return formatJSONResponse({
      message: 'Template added to your library',
      template: userTemplate
    }, 201);
  } catch (error) {
    console.error('Error using marketplace template:', error);
    return formatErrorResponse(error as Error);
  }
};

export const main = middyfy(useTemplate)
  .use(iamOnlyMiddleware())
  .use(subscriptionMiddleware());
