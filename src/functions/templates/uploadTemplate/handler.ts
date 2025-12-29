import { ValidatedEventAPIGatewayProxyEvent, formatJSONResponse, formatErrorResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { iamOnlyMiddleware } from '@libs/middleware/dualAuth';
import { subscriptionMiddleware } from '@libs/middleware/subscription';
import { usageTrackingMiddleware } from '@libs/middleware/usageTracking';
import { v4 as uuidv4 } from 'uuid';
import Handlebars from 'handlebars';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3Client = new S3Client({});

interface UploadTemplateBody {
  name: string;
  description?: string;
  content: string; // Base64 encoded or plain text Handlebars template
}

const uploadTemplate: ValidatedEventAPIGatewayProxyEvent<UploadTemplateBody> = async (event: any) => {
  try {
    const userId = event.userId!;
    const subscriptionLimits = event.subscriptionLimits;

    // Parse body (handle both JSON and multipart/form-data)
    let name: string;
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

      if (!name || !templateContent) {
        return formatJSONResponse({
          message: 'Missing required fields: name and file/content are required'
        }, 400);
      }
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

    if (!name) {
      return formatJSONResponse({ message: 'Template name is required' }, 400);
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

    // Check template count against subscription limit
    if (subscriptionLimits) {
      const existingTemplates = await docClient.send(new QueryCommand({
        TableName: process.env.TEMPLATES_TABLE!,
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
        Select: 'COUNT'
      }));

      const currentCount = existingTemplates.Count || 0;

      if (subscriptionLimits.maxTemplates !== -1 && currentCount >= subscriptionLimits.maxTemplates) {
        return formatJSONResponse({
          message: `Template limit reached. Your plan allows ${subscriptionLimits.maxTemplates} templates.`,
          currentCount,
          limit: subscriptionLimits.maxTemplates
        }, 429);
      }
    }

    // Generate template ID
    const templateId = uuidv4();
    const s3Key = `${userId}/templates/${templateId}.hbs`;
    const now = new Date().toISOString();

    // Upload to S3
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.ASSETS_BUCKET!,
      Key: s3Key,
      Body: templateContent,
      ContentType: 'text/x-handlebars-template',
      Metadata: {
        userId,
        templateName: name,
        uploadedAt: now
      }
    }));

    // Store metadata in DynamoDB
    const template = {
      userId,
      templateId,
      id: templateId, // Also include 'id' for frontend compatibility
      name,
      description: description || '',
      s3Key,
      fileSize: Buffer.byteLength(templateContent, 'utf-8'),
      createdAt: now,
      updatedAt: now
    };

    await docClient.send(new PutCommand({
      TableName: process.env.TEMPLATES_TABLE!,
      Item: template
    }));

    return formatJSONResponse(template, 201);
  } catch (error) {
    console.error('Error uploading template:', error);
    return formatErrorResponse(error as Error);
  }
};

export const main = middyfy(uploadTemplate)
  .use(iamOnlyMiddleware())
  .use(subscriptionMiddleware())
  .use(usageTrackingMiddleware({ actionType: 'template_upload' }));
