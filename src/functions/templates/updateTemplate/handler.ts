import { ValidatedEventAPIGatewayProxyEvent, formatJSONResponse, formatErrorResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { iamOnlyMiddleware } from '@libs/middleware/dualAuth';
import { subscriptionMiddleware } from '@libs/middleware/subscription';
import Handlebars from 'handlebars';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});

interface UpdateTemplateBody {
  name?: string;
  description?: string;
  content: string; // Base64 encoded or plain text Handlebars template
}

export const updateTemplate: ValidatedEventAPIGatewayProxyEvent<UpdateTemplateBody> = async (event: any) => {
  try {
    const userId = event.userId!;
    const templateId = event.pathParameters?.templateId;

    if (!templateId) {
      return formatJSONResponse({ message: 'Template ID is required' }, 400);
    }

    // Parse body (handle both JSON and multipart/form-data)
    let name: string | undefined;
    let description: string | undefined;
    let templateContent: string;

    const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';

    if (contentType.includes('multipart/form-data')) {
      // Parse multipart form data
      const boundary = contentType.split('boundary=')[1];
      if (!boundary) {
        return formatJSONResponse({ message: 'Invalid multipart boundary' }, 400);
      }

      const body = event.isBase64Encoded
        ? Buffer.from(event.body as string, 'base64').toString('utf-8')
        : event.body as string;

      const parts = body.split(`--${boundary}`);
      const fields: Record<string, string> = {};

      for (const part of parts) {
        if (part.includes('Content-Disposition')) {
          const nameMatch = part.match(/name="([^"]+)"/);

          if (nameMatch) {
            const fieldName = nameMatch[1];
            // Get content after headers (separated by double newline)
            const contentParts = part.split(/\r?\n\r?\n/);
            if (contentParts.length > 1) {
              // Remove trailing boundary markers and whitespace
              let content = contentParts.slice(1).join('\r\n\r\n').trim();
              content = content.replace(/\r?\n--$/, '').trim();
              fields[fieldName] = content;
            }
          }
        }
      }

      name = fields['name'];
      description = fields['description'];
      templateContent = fields['file'] || fields['content'];
    } else {
      // JSON body
      const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
      name = body.name;
      description = body.description;
      templateContent = body.content;

      // If content is base64 encoded, decode it
      if (body.contentEncoding === 'base64') {
        templateContent = Buffer.from(templateContent, 'base64').toString('utf-8');
      }
    }

    if (!templateContent) {
      return formatJSONResponse({ message: 'Template content is required' }, 400);
    }

    // Validate Handlebars syntax
    try {
      Handlebars.compile(templateContent);
    } catch (compileError: any) {
      return formatJSONResponse({
        message: 'Invalid Handlebars template',
        error: compileError.message
      }, 400);
    }

    // Verify the template exists and belongs to this user
    const existingResult = await docClient.send(new GetCommand({
      TableName: process.env.TEMPLATES_TABLE!,
      Key: {
        userId,
        templateId
      }
    }));

    if (!existingResult.Item) {
      return formatJSONResponse({ message: 'Template not found' }, 404);
    }

    const existingTemplate = existingResult.Item;
    const s3Key = existingTemplate.s3Key || `${userId}/templates/${templateId}.hbs`;
    const now = new Date().toISOString();
    const newName = name || existingTemplate.name;

    // Overwrite content in S3 at the SAME key
    const putResult = await s3Client.send(new PutObjectCommand({
      Bucket: process.env.ASSETS_BUCKET!,
      Key: s3Key,
      Body: templateContent,
      ContentType: 'text/x-handlebars-template',
      Metadata: {
        userId,
        templateName: newName,
        uploadedAt: now
      }
    }));

    // Update metadata in DynamoDB (preserve createdAt, thumbnailKey, etc.)
    const updatedTemplate: Record<string, unknown> = {
      ...existingTemplate,
      name: newName,
      description: description !== undefined ? description : (existingTemplate.description || ''),
      s3Key,
      fileSize: Buffer.byteLength(templateContent, 'utf-8'),
      contentVersion: putResult.VersionId || now,
      updatedAt: now
    };

    await docClient.send(new PutCommand({
      TableName: process.env.TEMPLATES_TABLE!,
      Item: updatedTemplate
    }));

    return formatJSONResponse(updatedTemplate);
  } catch (error) {
    console.error('Error updating template:', error);
    return formatErrorResponse(error as Error);
  }
};

export const main = middyfy(updateTemplate)
  .use(iamOnlyMiddleware()).use(subscriptionMiddleware());
