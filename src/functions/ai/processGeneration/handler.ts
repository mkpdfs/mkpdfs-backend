import { SQSHandler, SQSRecord } from 'aws-lambda';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import Handlebars from 'handlebars';
import {
  BedrockService,
  QuestionAnswer,
  StructuredQuestion,
  ImageAnalysis,
  AnalysisContext
} from '@libs/services/bedrockService';
import { PdfService } from '@libs/services/pdfService';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = new S3Client({});
const bedrockService = new BedrockService();
const pdfService = new PdfService();

interface AIJobMessage {
  jobId: string;
  userId: string;
  jobType?: 'analysis' | 'generation'; // Default 'generation' for backward compatibility
  prompt: string;
  templateType?: string;
  imageBase64?: string;
  imageMediaType?: 'image/png' | 'image/jpeg' | 'image/webp';
  imageS3Key?: string;
  // For generation jobs
  analysisJobId?: string;
  answers?: QuestionAnswer[];
  // Legacy iteration support
  previousTemplate?: string;
  feedback?: string;
}

// Analysis job record from DynamoDB (for fetching context)
interface AnalysisJobRecord {
  jobId: string;
  userId: string;
  jobType: 'analysis';
  status: string;
  prompt: string;
  questions?: StructuredQuestion[];
  imageAnalysis?: ImageAnalysis;
  imageS3Key?: string;
}

// Map S3 key extension to media type
const getMediaTypeFromKey = (s3Key: string): 'image/png' | 'image/jpeg' | 'image/webp' => {
  const ext = s3Key.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    default: return 'image/png'; // Default fallback
  }
};

// Fetch image from S3 and return as base64
const fetchImageFromS3 = async (s3Key: string): Promise<{ data: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' }> => {
  console.log(`[processAIJob] Fetching image from S3: ${s3Key}`);

  const response = await s3Client.send(new GetObjectCommand({
    Bucket: process.env.ASSETS_BUCKET,
    Key: s3Key
  }));

  if (!response.Body) {
    throw new Error('Image not found in S3');
  }

  // Convert stream to base64
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  const base64 = buffer.toString('base64');

  const mediaType = getMediaTypeFromKey(s3Key);
  console.log(`[processAIJob] Image fetched: ${buffer.length} bytes, type: ${mediaType}`);

  return { data: base64, mediaType };
};

const processAIJob: SQSHandler = async (event) => {
  // Process each message (typically batchSize: 1 for AI generation)
  for (const record of event.Records) {
    await processRecord(record);
  }
};

const processRecord = async (record: SQSRecord): Promise<void> => {
  const message: AIJobMessage = JSON.parse(record.body);
  const { jobId, userId, jobType = 'generation' } = message;

  console.log(`[processAIJob] Processing ${jobType} job ${jobId} for user ${userId}`);

  try {
    // Update job status to 'processing'
    await updateJobStatus(jobId, 'processing');

    if (jobType === 'analysis') {
      await processAnalysisJob(message);
    } else {
      await processGenerationJob(message);
    }

    console.log(`[processAIJob] Job ${jobId} (${jobType}) completed successfully`);
  } catch (error) {
    console.error(`[processAIJob] Job ${jobId} failed:`, error);
    await handleJobFailure(jobId, error as Error);
    // Re-throw to let SQS handle retry/DLQ
    throw error;
  }
};

// Process analysis job - generate clarifying questions
const processAnalysisJob = async (message: AIJobMessage): Promise<void> => {
  const { jobId, userId, prompt, templateType, imageBase64, imageMediaType, imageS3Key } = message;

  // Resolve image data - either from base64 or S3
  let image: { data: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' } | undefined;

  if (imageBase64 && imageMediaType) {
    image = { data: imageBase64, mediaType: imageMediaType };
  } else if (imageS3Key) {
    image = await fetchImageFromS3(imageS3Key);
  }

  // Analyze template requirements using Bedrock
  const result = await bedrockService.analyzeTemplate({
    prompt,
    templateType,
    image
  });

  // Calculate TTL (7 days from now)
  const ttl = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60);
  const completedAt = new Date().toISOString();

  // Build update expression dynamically based on whether imageAnalysis exists
  let updateExpression = `
    SET #status = :status,
        questions = :questions,
        completedAt = :completedAt,
        updatedAt = :updatedAt,
        #ttl = :ttl
  `;
  const expressionAttributeValues: Record<string, unknown> = {
    ':status': 'completed',
    ':questions': result.questions,
    ':completedAt': completedAt,
    ':updatedAt': completedAt,
    ':ttl': ttl
  };

  if (result.imageAnalysis) {
    updateExpression = updateExpression.replace('#ttl = :ttl', 'imageAnalysis = :imageAnalysis, #ttl = :ttl');
    expressionAttributeValues[':imageAnalysis'] = result.imageAnalysis;
  }

  // Update job as completed with questions
  await docClient.send(new UpdateCommand({
    TableName: process.env.AI_JOBS_TABLE,
    Key: { jobId },
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: {
      '#status': 'status',
      '#ttl': 'ttl'
    },
    ExpressionAttributeValues: expressionAttributeValues
  }));

  // Track AI usage for analysis jobs too
  await trackAIUsage(userId);
};

// Process generation job - create template (with optional analysis context)
const processGenerationJob = async (message: AIJobMessage): Promise<void> => {
  const {
    jobId,
    userId,
    prompt,
    templateType,
    imageBase64,
    imageMediaType,
    imageS3Key,
    analysisJobId,
    answers,
    previousTemplate,
    feedback
  } = message;

  // Resolve image data - either from base64 or S3
  let image: { data: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' } | undefined;

  if (imageBase64 && imageMediaType) {
    image = { data: imageBase64, mediaType: imageMediaType };
  } else if (imageS3Key) {
    image = await fetchImageFromS3(imageS3Key);
  }

  // Build analysis context if analysisJobId is provided
  let analysisContext: AnalysisContext | undefined;

  if (analysisJobId && answers) {
    // Fetch the analysis job to get questions and imageAnalysis
    const analysisJob = await fetchAnalysisJob(analysisJobId, userId);

    if (analysisJob && analysisJob.questions) {
      analysisContext = {
        questions: analysisJob.questions,
        answers,
        imageAnalysis: analysisJob.imageAnalysis
      };

      // If the analysis job had an image but this one doesn't, fetch it
      if (!image && analysisJob.imageS3Key) {
        image = await fetchImageFromS3(analysisJob.imageS3Key);
      }
    }
  }

  // Generate template using Bedrock
  const result = await bedrockService.generateTemplate({
    prompt,
    templateType,
    image,
    analysisContext,
    previousTemplate,
    feedback
  });

  // Calculate TTL (7 days from now)
  const ttl = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60);
  const completedAt = new Date().toISOString();

  // Generate thumbnail (non-fatal if fails)
  let thumbnailUrl: string | undefined;
  let thumbnailKey: string | undefined;
  try {
    console.log(`[processAIJob] Generating thumbnail for job ${jobId}`);

    // Compile template with sample data to get HTML
    const compiled = Handlebars.compile(result.template.content);
    const html = compiled(result.sampleData);

    // Generate screenshot
    const screenshotBuffer = await pdfService.generateScreenshot(html);

    // Upload to S3
    thumbnailKey = `users/${userId}/thumbnails/${jobId}.png`;
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.ASSETS_BUCKET,
      Key: thumbnailKey,
      Body: screenshotBuffer,
      ContentType: 'image/png',
      Metadata: {
        userId,
        jobId,
        generatedAt: completedAt
      }
    }));

    // Generate presigned URL (7 days to match job TTL)
    thumbnailUrl = await getSignedUrl(s3Client, new GetObjectCommand({
      Bucket: process.env.ASSETS_BUCKET!,
      Key: thumbnailKey
    }), { expiresIn: 7 * 24 * 60 * 60 });

    console.log(`[processAIJob] Thumbnail generated: ${thumbnailKey}`);
  } catch (thumbnailError) {
    console.error('[processAIJob] Thumbnail generation failed (non-fatal):', thumbnailError);
    // Continue without thumbnail - don't fail the job
  }

  // Update job as completed (include thumbnail info if generated)
  await docClient.send(new UpdateCommand({
    TableName: process.env.AI_JOBS_TABLE,
    Key: { jobId },
    UpdateExpression: `
      SET #status = :status,
          template = :template,
          sampleData = :sampleData,
          thumbnailKey = :thumbnailKey,
          thumbnailUrl = :thumbnailUrl,
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
      ':template': result.template,
      ':sampleData': result.sampleData,
      ':thumbnailKey': thumbnailKey || null,
      ':thumbnailUrl': thumbnailUrl || null,
      ':completedAt': completedAt,
      ':updatedAt': completedAt,
      ':ttl': ttl
    }
  }));

  // Track AI usage
  await trackAIUsage(userId);
};

// Fetch analysis job from DynamoDB
const fetchAnalysisJob = async (analysisJobId: string, userId: string): Promise<AnalysisJobRecord | null> => {
  try {
    const result = await docClient.send(new GetCommand({
      TableName: process.env.AI_JOBS_TABLE,
      Key: { jobId: analysisJobId }
    }));

    if (!result.Item) {
      console.warn(`[processAIJob] Analysis job ${analysisJobId} not found`);
      return null;
    }

    // Validate ownership
    if (result.Item.userId !== userId) {
      console.warn(`[processAIJob] Analysis job ${analysisJobId} belongs to different user`);
      return null;
    }

    // Validate it's an analysis job
    if (result.Item.jobType !== 'analysis') {
      console.warn(`[processAIJob] Job ${analysisJobId} is not an analysis job`);
      return null;
    }

    // Validate it's completed
    if (result.Item.status !== 'completed') {
      console.warn(`[processAIJob] Analysis job ${analysisJobId} is not completed`);
      return null;
    }

    return result.Item as AnalysisJobRecord;
  } catch (error) {
    console.error(`[processAIJob] Error fetching analysis job ${analysisJobId}:`, error);
    return null;
  }
};

const updateJobStatus = async (jobId: string, status: string): Promise<void> => {
  await docClient.send(new UpdateCommand({
    TableName: process.env.AI_JOBS_TABLE,
    Key: { jobId },
    UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': status,
      ':updatedAt': new Date().toISOString()
    }
  }));
};

const trackAIUsage = async (userId: string): Promise<void> => {
  const currentMonth = new Date().toISOString().substring(0, 7);

  try {
    await docClient.send(new UpdateCommand({
      TableName: process.env.USAGE_TABLE,
      Key: {
        userId,
        yearMonth: currentMonth
      },
      UpdateExpression: 'SET lastActivity = :now ADD aiGenerationCount :count',
      ExpressionAttributeValues: {
        ':now': new Date().toISOString(),
        ':count': 1
      }
    }));
  } catch (error) {
    console.error('[processAIJob] Failed to track AI usage:', error);
    // Don't throw - usage tracking failure shouldn't fail the job
  }
};

const handleJobFailure = async (jobId: string, error: Error): Promise<void> => {
  const errorCode = classifyError(error);
  const completedAt = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60);

  try {
    await docClient.send(new UpdateCommand({
      TableName: process.env.AI_JOBS_TABLE,
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
  } catch (updateError) {
    console.error('[processAIJob] Failed to update job failure status:', updateError);
    // Don't throw - the original error is more important
  }
};

const classifyError = (error: Error): string => {
  const message = error.message.toLowerCase();
  const name = error.name?.toLowerCase() || '';

  if (name.includes('throttling')) return 'SERVICE_THROTTLED';
  if (name.includes('timeout')) return 'GENERATION_TIMEOUT';
  if (message.includes('invalid handlebars')) return 'INVALID_TEMPLATE';
  if (message.includes('failed to parse')) return 'PARSE_ERROR';
  if (message.includes('content filter')) return 'CONTENT_BLOCKED';
  if (message.includes('nosuchkey')) return 'IMAGE_NOT_FOUND';
  return 'GENERATION_ERROR';
};

export const main = processAIJob;
