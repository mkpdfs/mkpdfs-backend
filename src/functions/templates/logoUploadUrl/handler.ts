import { ValidatedEventAPIGatewayProxyEvent, formatJSONResponse, formatErrorResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';
import { iamOnlyMiddleware } from '@libs/middleware/dualAuth';
import { subscriptionMiddleware } from '@libs/middleware/subscription';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';

const s3Client = new S3Client({});

const ALLOWED: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

interface Body { contentType: string }

export const logoUploadUrl: ValidatedEventAPIGatewayProxyEvent<Body> = async (event: any) => {
  try {
    const userId = event.userId!;
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    const ext = ALLOWED[body?.contentType];
    if (!ext) {
      return formatJSONResponse(
        { message: 'contentType must be image/png, image/jpeg, image/webp or image/svg+xml' }, 400);
    }
    const s3Key = `users/${userId}/logos/${uuidv4()}.${ext}`;
    const uploadUrl = await getSignedUrl(s3Client, new PutObjectCommand({
      Bucket: process.env.ASSETS_BUCKET!,
      Key: s3Key,
      ContentType: body.contentType,
      Metadata: { 'user-id': userId, 'upload-purpose': 'template-logo' },
    }), { expiresIn: 300 });
    return formatJSONResponse({ uploadUrl, s3Key, expiresIn: 300 });
  } catch (error) {
    return formatErrorResponse(error as Error);
  }
};

export const main = middyfy(logoUploadUrl)
  .use(iamOnlyMiddleware())
  .use(subscriptionMiddleware());
