import { SQSHandler, SQSRecord } from 'aws-lambda';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PdfService } from '@libs/services/pdfService';
import { WebhookService } from '@libs/services/webhookService';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const pdfService = new PdfService();
const webhookService = new WebhookService();

interface JobMessage {
  jobId: string;
  userId: string;
  templateId: string;
  data: any;
  sendEmail?: string[];
  pageCount: number;
}

interface JobRecord {
  jobId: string;
  userId: string;
  status: string;
  templateId: string;
  data: any;
  webhookUrl?: string;
  webhookSecret?: string;
  sendEmail?: string[];
  pageCount: number;
  pdfUrl?: string;
  pdfKey?: string;
  sizeBytes?: number;
  error?: string;
  errorCode?: string;
  webhookStatus?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  ttl?: number;
}

const processJob: SQSHandler = async (event) => {
  // Process each message (typically batchSize: 1 for PDF generation)
  for (const record of event.Records) {
    await processRecord(record);
  }
};

const processRecord = async (record: SQSRecord): Promise<void> => {
  const message: JobMessage = JSON.parse(record.body);
  const { jobId, userId, templateId, data, sendEmail, pageCount } = message;

  console.log(`Processing job ${jobId} for user ${userId}`);

  try {
    // Update job status to 'processing'
    await updateJobStatus(jobId, 'processing');

    // Generate PDF using existing PdfService
    const result = await pdfService.generatePdf({
      userId,
      templateId,
      data,
      sendEmail
    });

    // Calculate TTL (7 days from now)
    const ttl = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60);
    const completedAt = new Date().toISOString();

    // Update job as completed
    await docClient.send(new UpdateCommand({
      TableName: process.env.JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: `
        SET #status = :status,
            pdfUrl = :pdfUrl,
            pdfKey = :pdfKey,
            sizeBytes = :sizeBytes,
            completedAt = :completedAt,
            updatedAt = :updatedAt,
            #ttl = :ttl
      `,
      ExpressionAttributeNames: {
        '#status': 'status',
        '#ttl': 'ttl'
      },
      ExpressionAttributeValues: {
        ':status': 'completed',
        ':pdfUrl': result.url,
        ':pdfKey': result.key,
        ':sizeBytes': result.sizeBytes,
        ':completedAt': completedAt,
        ':updatedAt': completedAt,
        ':ttl': ttl
      }
    }));

    // Track usage
    await trackUsage(userId, pageCount, result.sizeBytes);

    // Get full job record for webhook
    const jobRecord = await getJob(jobId);

    // Send webhook if configured
    if (jobRecord?.webhookUrl) {
      await webhookService.sendWebhook({
        jobId,
        webhookUrl: jobRecord.webhookUrl,
        webhookSecret: jobRecord.webhookSecret,
        event: 'job.completed',
        data: {
          jobId,
          status: 'completed',
          pdfUrl: result.url,
          pageCount,
          sizeBytes: result.sizeBytes,
          createdAt: jobRecord.createdAt,
          completedAt
        }
      });
    }

    console.log(`Job ${jobId} completed successfully`);
  } catch (error) {
    console.error(`Job ${jobId} failed:`, error);
    await handleJobFailure(jobId, error as Error);
    // Re-throw to let SQS handle retry/DLQ
    throw error;
  }
};

const updateJobStatus = async (jobId: string, status: string): Promise<void> => {
  await docClient.send(new UpdateCommand({
    TableName: process.env.JOBS_TABLE,
    Key: { jobId },
    UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': status,
      ':updatedAt': new Date().toISOString()
    }
  }));
};

const getJob = async (jobId: string): Promise<JobRecord | null> => {
  const result = await docClient.send(new GetCommand({
    TableName: process.env.JOBS_TABLE,
    Key: { jobId }
  }));
  return result.Item as JobRecord | null;
};

const trackUsage = async (userId: string, pageCount: number, sizeBytes: number): Promise<void> => {
  const currentMonth = new Date().toISOString().substring(0, 7);

  try {
    await docClient.send(new UpdateCommand({
      TableName: process.env.USAGE_TABLE,
      Key: {
        userId,
        yearMonth: currentMonth
      },
      UpdateExpression: 'SET lastActivity = :now ADD pdfCount :pageCount, totalSizeBytes :sizeBytes',
      ExpressionAttributeValues: {
        ':now': new Date().toISOString(),
        ':pageCount': pageCount,
        ':sizeBytes': sizeBytes
      }
    }));
  } catch (error) {
    console.error('Failed to track usage:', error);
    // Don't throw - usage tracking failure shouldn't fail the job
  }
};

const handleJobFailure = async (jobId: string, error: Error): Promise<void> => {
  const errorCode = classifyError(error);
  const completedAt = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60);

  try {
    // Update job as failed
    await docClient.send(new UpdateCommand({
      TableName: process.env.JOBS_TABLE,
      Key: { jobId },
      UpdateExpression: `
        SET #status = :status,
            #error = :error,
            errorCode = :errorCode,
            completedAt = :completedAt,
            updatedAt = :updatedAt,
            #ttl = :ttl
      `,
      ExpressionAttributeNames: {
        '#status': 'status',
        '#error': 'error',
        '#ttl': 'ttl'
      },
      ExpressionAttributeValues: {
        ':status': 'failed',
        ':error': error.message,
        ':errorCode': errorCode,
        ':completedAt': completedAt,
        ':updatedAt': completedAt,
        ':ttl': ttl
      }
    }));

    // Get job for webhook
    const jobRecord = await getJob(jobId);

    // Send failure webhook if configured
    if (jobRecord?.webhookUrl) {
      await webhookService.sendWebhook({
        jobId,
        webhookUrl: jobRecord.webhookUrl,
        webhookSecret: jobRecord.webhookSecret,
        event: 'job.failed',
        data: {
          jobId,
          status: 'failed',
          error: error.message,
          errorCode,
          createdAt: jobRecord.createdAt,
          completedAt
        }
      });
    }
  } catch (updateError) {
    console.error('Failed to update job failure status:', updateError);
    // Don't throw - the original error is more important
  }
};

const classifyError = (error: Error): string => {
  const message = error.message.toLowerCase();
  if (message.includes('template not found')) return 'TEMPLATE_NOT_FOUND';
  if (message.includes('timeout')) return 'GENERATION_TIMEOUT';
  if (message.includes('memory')) return 'MEMORY_EXCEEDED';
  if (message.includes('nosuchkey')) return 'TEMPLATE_NOT_FOUND';
  return 'GENERATION_ERROR';
};

export const main = processJob;
