import { ValidatedEventAPIGatewayProxyEvent, formatJSONResponse, formatErrorResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';
import { iamOnlyMiddleware } from '@libs/middleware/dualAuth';
import { subscriptionMiddleware } from '@libs/middleware/subscription';
import { checkAILimitsMiddleware } from '@libs/middleware/aiLimits';
import { usageTrackingMiddleware } from '@libs/middleware/usageTracking';
import { BedrockService } from '@libs/services/bedrockService';

const bedrockService = new BedrockService();

interface GenerateTemplateBody {
  prompt: string;
  templateType?: string;
  imageBase64?: string;
  imageMediaType?: 'image/png' | 'image/jpeg' | 'image/webp';
  previousTemplate?: string;
  feedback?: string;
}

const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const MAX_IMAGE_SIZE_BASE64 = 5 * 1024 * 1024 * 1.34; // ~6.7MB base64 for 5MB binary

const generateTemplate: ValidatedEventAPIGatewayProxyEvent<GenerateTemplateBody> = async (event: any) => {
  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    const { prompt, templateType, imageBase64, imageMediaType, previousTemplate, feedback } = body;

    if (!prompt || typeof prompt !== 'string') {
      return formatJSONResponse({
        success: false,
        error: 'INVALID_PROMPT',
        message: 'A prompt is required to generate a template'
      }, 400);
    }

    if (prompt.length < 10) {
      return formatJSONResponse({
        success: false,
        error: 'PROMPT_TOO_SHORT',
        message: 'Please provide a more detailed description (at least 10 characters)'
      }, 400);
    }

    if (prompt.length > 2000) {
      return formatJSONResponse({
        success: false,
        error: 'PROMPT_TOO_LONG',
        message: 'Prompt is too long. Please keep it under 2000 characters.'
      }, 400);
    }

    // Image validation
    if (imageBase64) {
      // Validate media type
      if (!imageMediaType || !ALLOWED_IMAGE_TYPES.includes(imageMediaType as typeof ALLOWED_IMAGE_TYPES[number])) {
        return formatJSONResponse({
          success: false,
          error: 'INVALID_IMAGE_TYPE',
          message: 'Image must be PNG, JPEG, or WebP format'
        }, 400);
      }

      // Validate size (base64 is ~33% larger than binary)
      if (imageBase64.length > MAX_IMAGE_SIZE_BASE64) {
        return formatJSONResponse({
          success: false,
          error: 'IMAGE_TOO_LARGE',
          message: 'Image must be under 5MB'
        }, 400);
      }

      // Basic base64 validation
      if (!/^[A-Za-z0-9+/=]+$/.test(imageBase64)) {
        return formatJSONResponse({
          success: false,
          error: 'INVALID_IMAGE_DATA',
          message: 'Invalid image data format'
        }, 400);
      }
    }

    // Generate template using Bedrock
    const result = await bedrockService.generateTemplate({
      prompt,
      templateType,
      image: imageBase64 && imageMediaType ? {
        data: imageBase64,
        mediaType: imageMediaType
      } : undefined,
      previousTemplate,
      feedback
    });

    // Calculate remaining generations after this one
    const aiGenerationsRemaining = event.aiGenerationsRemaining;
    const remaining = aiGenerationsRemaining === -1
      ? -1  // unlimited
      : Math.max(0, aiGenerationsRemaining - 1);

    return formatJSONResponse({
      success: true,
      template: result.template,
      sampleData: result.sampleData,
      remainingGenerations: remaining
    });

  } catch (error: any) {
    console.error('Error generating template:', error);

    // Handle specific Bedrock errors
    if (error.name === 'ThrottlingException') {
      return formatJSONResponse({
        success: false,
        error: 'SERVICE_BUSY',
        message: 'AI service is temporarily busy. Please try again in a moment.',
        retryable: true
      }, 503);
    }

    if (error.name === 'ModelTimeoutException') {
      return formatJSONResponse({
        success: false,
        error: 'TIMEOUT',
        message: 'AI generation timed out. Please try with a simpler prompt.',
        retryable: true
      }, 504);
    }

    // Handle validation errors
    if (error.message?.includes('Invalid Handlebars') ||
        error.message?.includes('Failed to parse')) {
      return formatJSONResponse({
        success: false,
        error: 'GENERATION_FAILED',
        message: 'Failed to generate a valid template. Please try rephrasing your prompt.',
        retryable: true
      }, 422);
    }

    return formatErrorResponse(error);
  }
};

export const main = middyfy(generateTemplate)
  .use(iamOnlyMiddleware())
  .use(subscriptionMiddleware())
  .use(checkAILimitsMiddleware())
  .use(usageTrackingMiddleware({ actionType: 'ai_generation' }));
