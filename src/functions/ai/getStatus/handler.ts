import { ValidatedEventAPIGatewayProxyEvent, formatJSONResponse, formatErrorResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';
import { iamOnlyMiddleware } from '@libs/middleware/dualAuth';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { StructuredQuestion, ImageAnalysis } from '@libs/services/bedrockService';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

interface AIJobRecord {
  jobId: string;
  userId: string;
  jobType?: 'analysis' | 'generation'; // Optional for backward compatibility
  status: 'pending' | 'processing' | 'completed' | 'failed';
  prompt: string;
  templateType?: string;
  hasImage: boolean;
  // Analysis job output
  questions?: StructuredQuestion[];
  imageAnalysis?: ImageAnalysis;
  // Generation job output
  template?: {
    content: string;
    name: string;
    description: string;
  };
  sampleData?: Record<string, unknown>;
  thumbnailKey?: string; // S3 key for template thumbnail (for saving)
  thumbnailUrl?: string; // Presigned URL for template thumbnail (for display)
  // Common fields
  error?: string;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

const getAIJobStatus: ValidatedEventAPIGatewayProxyEvent<void> = async (event) => {
  try {
    const userId = event.userId!;
    const jobId = event.pathParameters?.jobId;

    console.log('[getAIJobStatus] Request:', { jobId, userId, table: process.env.AI_JOBS_TABLE });

    if (!jobId) {
      return formatErrorResponse(new Error('jobId is required'), 400);
    }

    // Get job from DynamoDB
    const result = await docClient.send(new GetCommand({
      TableName: process.env.AI_JOBS_TABLE,
      Key: { jobId }
    }));

    console.log('[getAIJobStatus] DynamoDB result:', { found: !!result.Item, jobUserId: result.Item?.userId });

    if (!result.Item) {
      return formatErrorResponse(new Error('Job not found'), 404);
    }

    const job = result.Item as AIJobRecord;

    // Security: Ensure user owns this job
    if (job.userId !== userId) {
      console.log('[getAIJobStatus] Ownership mismatch:', { jobUserId: job.userId, requestUserId: userId });
      return formatErrorResponse(new Error('Job not found'), 404);
    }

    // Build response based on status
    const response: Record<string, unknown> = {
      jobId: job.jobId,
      jobType: job.jobType || 'generation', // Default for backward compatibility
      status: job.status,
      prompt: job.prompt.substring(0, 100) + (job.prompt.length > 100 ? '...' : ''), // Truncate for response
      hasImage: job.hasImage,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };

    if (job.status === 'completed') {
      response.completedAt = job.completedAt;

      // Return different fields based on job type
      if (job.jobType === 'analysis') {
        // Analysis job - return questions and imageAnalysis
        response.questions = job.questions;
        if (job.imageAnalysis) {
          response.imageAnalysis = job.imageAnalysis;
        }
      } else {
        // Generation job - return template, sampleData, and thumbnail info
        response.template = job.template;
        response.sampleData = job.sampleData;
        response.thumbnailKey = job.thumbnailKey || null;
        response.thumbnailUrl = job.thumbnailUrl || null;
      }
    } else if (job.status === 'failed') {
      response.error = job.error;
      response.errorCode = job.errorCode;
      response.completedAt = job.completedAt;
    }

    return formatJSONResponse(response);
  } catch (error) {
    console.error('Error getting AI job status:', error);
    return formatErrorResponse(error as Error);
  }
};

// Only IAM middleware needed for status check (no subscription/limits)
export const main = middyfy(getAIJobStatus)
  .use(iamOnlyMiddleware());
