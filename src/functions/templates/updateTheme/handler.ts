import { ValidatedEventAPIGatewayProxyEvent, formatJSONResponse, formatErrorResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';
import { iamOnlyMiddleware } from '@libs/middleware/dualAuth';
import { subscriptionMiddleware } from '@libs/middleware/subscription';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { resolveThemeInput } from '@libs/theme/resolveLogoInput';
import { ThemeInput } from '@libs/theme/themeTypes';

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const updateTheme: ValidatedEventAPIGatewayProxyEvent<ThemeInput> = async (event: any) => {
  try {
    const userId = event.userId!;
    const templateId = event.pathParameters?.templateId;
    if (!templateId) return formatJSONResponse({ message: 'Template ID is required' }, 400);

    const existing = await docClient.send(new GetCommand({
      TableName: process.env.TEMPLATES_TABLE!,
      Key: { userId, templateId },
    }));
    if (!existing.Item) return formatJSONResponse({ message: 'Template not found' }, 404);

    const input = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;

    let theme;
    try {
      theme = await resolveThemeInput(userId, input as ThemeInput);
    } catch (err: any) {
      if (err?.name === 'ThemeValidationError' || err?.name === 'LogoIngestError') {
        return formatJSONResponse({ message: err.message }, 400);
      }
      throw err;
    }

    await docClient.send(new UpdateCommand({
      TableName: process.env.TEMPLATES_TABLE!,
      Key: { userId, templateId },
      UpdateExpression: 'SET #theme = :theme, updatedAt = :now',
      ExpressionAttributeNames: { '#theme': 'theme' },
      ExpressionAttributeValues: { ':theme': theme, ':now': new Date().toISOString() },
    }));

    return formatJSONResponse({ message: 'Theme updated', theme });
  } catch (error) {
    return formatErrorResponse(error as Error);
  }
};

export const main = middyfy(updateTheme)
  .use(iamOnlyMiddleware())
  .use(subscriptionMiddleware());
