import { ValidatedEventAPIGatewayProxyEvent, formatJSONResponse, formatErrorResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';
import { dualAuthMiddleware } from '@libs/middleware/dualAuth';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

interface JobRecord {
  jobId: string;
  userId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  templateId: string;
  pageCount: number;
  pdfUrl?: string;
  sizeBytes?: number;
  error?: string;
  errorCode?: string;
  webhookStatus?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

const getJobStatus: ValidatedEventAPIGatewayProxyEvent<void> = async (event) => {
  try {
    const userId = event.userId!;
    const jobId = event.pathParameters?.jobId;

    console.log('[getJobStatus] Request:', { jobId, userId, table: process.env.JOBS_TABLE });

    if (!jobId) {
      return formatErrorResponse(new Error('jobId is required'), 400);
    }

    // Get job from DynamoDB
    const result = await docClient.send(new GetCommand({
      TableName: process.env.JOBS_TABLE,
      Key: { jobId }
    }));

    console.log('[getJobStatus] DynamoDB result:', { found: !!result.Item, jobUserId: result.Item?.userId });

    if (!result.Item) {
      return formatErrorResponse(new Error('Job not found'), 404);
    }

    const job = result.Item as JobRecord;

    // Security: Ensure user owns this job
    if (job.userId !== userId) {
      console.log('[getJobStatus] Ownership mismatch:', { jobUserId: job.userId, requestUserId: userId });
      return formatErrorResponse(new Error('Job not found'), 404);
    }

    // Build response based on status
    const response: any = {
      jobId: job.jobId,
      status: job.status,
      templateId: job.templateId,
      pageCount: job.pageCount,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };

    if (job.status === 'completed') {
      response.pdfUrl = job.pdfUrl;
      response.sizeBytes = job.sizeBytes;
      response.completedAt = job.completedAt;
      response.expiresIn = '5 days';
    } else if (job.status === 'failed') {
      response.error = job.error;
      response.errorCode = job.errorCode;
      response.completedAt = job.completedAt;
    }

    // Include webhook status if webhook was configured
    if (job.webhookStatus) {
      response.webhookStatus = job.webhookStatus;
    }

    return formatJSONResponse(response);
  } catch (error) {
    console.error('Error getting job status:', error);
    return formatErrorResponse(error as Error);
  }
};

// Only dualAuth middleware needed for status check
export const main = middyfy(getJobStatus)
  .use(dualAuthMiddleware());
