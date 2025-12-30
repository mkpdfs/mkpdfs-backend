import { ValidatedEventAPIGatewayProxyEvent, formatJSONResponse, formatErrorResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';
import { dualAuthMiddleware } from '@libs/middleware/dualAuth';
import { subscriptionMiddleware } from '@libs/middleware/subscription';
import { checkLimitsMiddleware } from '@libs/middleware/usageTracking';
import { WebhookService } from '@libs/services/webhookService';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { v4 as uuidv4 } from 'uuid';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const sqsClient = new SQSClient({});

// Get SQS queue URL - handle cases where CloudFormation refs aren't resolved (e.g., sls offline)
const getQueueUrl = (): string => {
  const queueUrl = process.env.PDF_GENERATION_QUEUE_URL;

  // If it's a valid URL string, use it directly
  if (typeof queueUrl === 'string' && queueUrl.startsWith('https://')) {
    return queueUrl;
  }

  // CloudFormation ref not resolved - construct the real AWS URL
  // AWS SQS URL format: https://sqs.{region}.amazonaws.com/{account-id}/{queue-name}
  const region = process.env.REGION || 'us-east-1';
  const stage = process.env.STAGE || 'dev';
  const queueName = `mkpdfs-${stage}-pdf-generation`;

  return `https://sqs.${region}.amazonaws.com/197837191835/${queueName}`;
};

interface SubmitJobRequest {
  templateId: string;
  data: any;
  webhookUrl?: string;
  webhookSecret?: string;
  sendEmail?: string[];
}

const MAX_ITEMS_PER_REQUEST = 50;

const submitJob: ValidatedEventAPIGatewayProxyEvent<SubmitJobRequest> = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  try {
    const userId = event.userId!;
    const { templateId, data, webhookUrl, webhookSecret, sendEmail } = event.body;

    console.log('[submitJob] Request:', { userId, templateId, table: process.env.JOBS_TABLE, queueUrl: process.env.PDF_GENERATION_QUEUE_URL });

    // Validate required fields
    if (!templateId) {
      return formatErrorResponse(new Error('templateId is required'), 400);
    }

    if (!data) {
      return formatErrorResponse(new Error('data is required'), 400);
    }

    // Validate array size - each object = 1 page
    const pageCount = Array.isArray(data) ? data.length : 1;

    if (pageCount > MAX_ITEMS_PER_REQUEST) {
      return formatErrorResponse(
        new Error(`Maximum ${MAX_ITEMS_PER_REQUEST} items allowed per request. Received: ${pageCount}`),
        400
      );
    }

    // Validate webhook URL if provided
    if (webhookUrl) {
      try {
        WebhookService.validateWebhookUrl(webhookUrl);
      } catch (error) {
        return formatErrorResponse(error as Error, 400);
      }
    }

    // Store pageCount on event for limit checking middleware
    (event as any).pageCount = pageCount;

    // Generate job ID
    const jobId = uuidv4();
    const now = new Date().toISOString();

    // Create job record in DynamoDB
    const jobRecord = {
      jobId,
      userId,
      status: 'pending',
      templateId,
      data, // Store for processing
      webhookUrl: webhookUrl || null,
      webhookSecret: webhookSecret || null,
      sendEmail: sendEmail || null,
      pageCount,
      webhookStatus: webhookUrl ? 'pending' : null,
      webhookAttempts: 0,
      createdAt: now,
      updatedAt: now
    };

    await docClient.send(new PutCommand({
      TableName: process.env.JOBS_TABLE,
      Item: jobRecord
    }));

    console.log('[submitJob] Job created in DynamoDB:', { jobId, userId, status: 'pending' });

    // Send message to SQS queue
    const queueUrl = getQueueUrl();
    console.log('[submitJob] Sending to SQS:', { queueUrl });

    await sqsClient.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        jobId,
        userId,
        templateId,
        data,
        sendEmail,
        pageCount
      })
    }));

    console.log('[submitJob] SQS message sent successfully');

    // Build status URL
    const baseUrl = process.env.FRONTEND_URL?.replace('https://', 'https://apis.').replace('.mkpdfs.com', '.apis.mkpdfs.com') ||
      `https://${process.env.STAGE === 'prod' ? '' : process.env.STAGE + '.'}apis.mkpdfs.com`;
    const statusUrl = `${baseUrl}/jobs/${jobId}`;

    return formatJSONResponse({
      success: true,
      jobId,
      status: 'pending',
      statusUrl,
      pageCount,
      message: 'PDF generation job submitted successfully'
    }, 202);
  } catch (error) {
    console.error('Error submitting job:', error);
    return formatErrorResponse(error as Error);
  }
};

// Note: No usageTrackingMiddleware here - usage is tracked when job completes
export const main = middyfy(submitJob)
  .use(dualAuthMiddleware())
  .use(subscriptionMiddleware())
  .use(checkLimitsMiddleware('pdf_generation'));
