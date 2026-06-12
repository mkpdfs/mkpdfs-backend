import { ValidatedEventAPIGatewayProxyEvent, formatJSONResponse, formatErrorResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';
import { dualAuthMiddleware } from '@libs/middleware/dualAuth';
import { subscriptionMiddleware } from '@libs/middleware/subscription';
import { usageTrackingMiddleware } from '@libs/middleware/usageTracking';
import { checkCreditsMiddleware, debitCreditsMiddleware } from '@libs/middleware/credits';
import { PdfService } from '@libs/services/pdfService';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const lambdaClient = new LambdaClient({});
const pdfService = new PdfService();

interface GeneratePdfRequest {
  templateId: string;
  data: any;
  async?: boolean;
  sendEmail?: string[];
}

const MAX_ITEMS_PER_REQUEST = 50;

// Exported so the API-key-only route (POST /v1/pdf/generate) can reuse the
// exact same business logic with a different auth middleware. Do not duplicate.
export const generatePdf: ValidatedEventAPIGatewayProxyEvent<GeneratePdfRequest> = async (event, context) => {
  // Don't wait for empty event loop
  context.callbackWaitsForEmptyEventLoop = false;

  try {
    const userId = event.userId!;
    const { templateId, data, async = false, sendEmail } = event.body;

    // Validate array size - each object = 1 page
    const pageCount = Array.isArray(data) ? data.length : 1;

    if (pageCount > MAX_ITEMS_PER_REQUEST) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Credentials': true,
        },
        body: JSON.stringify({
          message: `Maximum ${MAX_ITEMS_PER_REQUEST} items allowed per request`,
          itemsReceived: pageCount,
          maxAllowed: MAX_ITEMS_PER_REQUEST
        })
      };
    }
    
    // Store pageCount on event for usage tracking middleware
    (event as any).pageCount = pageCount;

    if (async) {
      // NOTE: this deprecated path returns 200, so debitCreditsMiddleware
      // bills at submission time. If generatePdfAsync (currently a stub) is
      // ever revived, it must NOT debit again on completion.
      // Invoke async Lambda with pageCount for usage tracking.
      // GENERATE_PDF_ASYNC_FUNCTION_NAME is injected by CDK with the real
      // function name; the legacy `${service}-${stage}-generatePdfAsync`
      // fallback keeps the still-live Serverless stack working (enmienda 3).
      const command = new InvokeCommand({
        FunctionName:
          process.env.GENERATE_PDF_ASYNC_FUNCTION_NAME ||
          `${process.env.SERVICE_NAME}-${process.env.STAGE}-generatePdfAsync`,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({
          userId,
          templateId,
          data,
          sendEmail,
          pageCount
        }))
      });

      await lambdaClient.send(command);

      return formatJSONResponse({
        success: true,
        message: 'PDF generation started. You will receive an email when ready.',
        async: true,
        pagesGenerated: pageCount
      });
    } else {
      // Generate PDF synchronously
      const result = await pdfService.generatePdf({
        userId,
        templateId,
        data,
        sendEmail
      });

      return formatJSONResponse({
        success: true,
        pdfUrl: result.url,
        expiresIn: '5 days',
        size: result.sizeBytes,
        pagesGenerated: pageCount
      });
    }
  } catch (error) {
    return formatErrorResponse(error);
  }
};

export const main = middyfy(generatePdf)
  .use(dualAuthMiddleware())
  .use(subscriptionMiddleware())
  .use(checkCreditsMiddleware())
  .use(usageTrackingMiddleware({ actionType: 'pdf_generation' }))
  .use(debitCreditsMiddleware());