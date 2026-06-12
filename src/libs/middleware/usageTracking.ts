import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

interface UsageTrackingOptions {
  actionType: 'pdf_generation' | 'template_upload' | 'token_creation' | 'ai_generation';
  sizeInBytes?: number;
}

export const usageTrackingMiddleware = (options: UsageTrackingOptions) => {
  return {
    after: async (handler: any) => {
      console.log('[UsageTracking] after hook triggered', {
        actionType: options.actionType,
        statusCode: handler.response?.statusCode,
        userId: handler.event.userId
      });

      // Only track successful requests
      if (handler.response?.statusCode !== 200) {
        console.log('[UsageTracking] Skipping - statusCode is not 200');
        return;
      }

      const userId = handler.event.userId;
      if (!userId) {
        console.log('[UsageTracking] Skipping - no userId');
        return;
      }
      
      const currentMonth = new Date().toISOString().substring(0, 7); // YYYY-MM format

      try {
        const addExpressions: string[] = [];
        const setExpressions: string[] = [];
        const expressionAttributeValues: Record<string, any> = {};

        // Track different types of actions
        switch (options.actionType) {
          case 'pdf_generation':
            // Use pageCount from handler (each object in array = 1 page)
            const pageCount = handler.event.pageCount || 1;
            addExpressions.push('pdfCount :inc');
            expressionAttributeValues[':inc'] = pageCount;

            console.log('[UsageTracking] PDF generation - pages:', pageCount);

            if (options.sizeInBytes) {
              addExpressions.push('totalSizeBytes :size');
              expressionAttributeValues[':size'] = options.sizeInBytes;
            }
            break;

          case 'template_upload':
            addExpressions.push('templateUploads :inc');
            expressionAttributeValues[':inc'] = 1;
            break;

          case 'token_creation':
            addExpressions.push('tokensCreated :inc');
            expressionAttributeValues[':inc'] = 1;
            break;

          case 'ai_generation':
            addExpressions.push('aiGenerations :inc');
            expressionAttributeValues[':inc'] = 1;
            console.log('[UsageTracking] AI generation tracked');
            break;
        }

        // Update last activity timestamp
        setExpressions.push('lastActivity = :now');
        expressionAttributeValues[':now'] = new Date().toISOString();

        // Build proper UpdateExpression: "SET x = :x ADD y :y"
        const updateParts: string[] = [];
        if (setExpressions.length > 0) {
          updateParts.push(`SET ${setExpressions.join(', ')}`);
        }
        if (addExpressions.length > 0) {
          updateParts.push(`ADD ${addExpressions.join(', ')}`);
        }
        const updateExpression = updateParts.join(' ');

        // Update usage in DynamoDB
        console.log('[UsageTracking] Updating DynamoDB', {
          table: process.env.USAGE_TABLE,
          userId,
          yearMonth: currentMonth,
          updateExpression
        });

        await docClient.send(new UpdateCommand({
          TableName: process.env.USAGE_TABLE!,
          Key: {
            userId,
            yearMonth: currentMonth
          },
          UpdateExpression: updateExpression,
          ExpressionAttributeValues: expressionAttributeValues
        }));

        console.log('[UsageTracking] Successfully updated usage');

      } catch (error) {
        console.error('[UsageTracking] Error tracking usage:', error);
        // Don't fail the request due to tracking errors
      }
    }
  };
};

