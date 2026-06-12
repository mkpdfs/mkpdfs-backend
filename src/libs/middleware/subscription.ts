import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

export interface SubscriptionLimits {
  templatesAllowed: number;
  apiTokensAllowed: number;
  maxPdfSizeMB: number;
  aiGenerationsPerMonth: number; // fixed monthly quota, requires creditBalance > 0
}

export const SUBSCRIPTION_PLANS: Record<string, SubscriptionLimits> = {
  credits: {
    templatesAllowed: 500,
    apiTokensAllowed: 10,
    maxPdfSizeMB: 50,
    aiGenerationsPerMonth: 15,
  },
  enterprise: {
    templatesAllowed: -1, // unlimited
    apiTokensAllowed: -1,
    maxPdfSizeMB: 100,
    aiGenerationsPerMonth: -1,
  },
};

export const subscriptionMiddleware = () => {
  return {
    before: async (handler: any): Promise<any> => {
      const userId = handler.event.userId;
      
      if (!userId) {
        return; // No user, let other middleware handle auth
      }
      
      try {
        // Get subscription data
        const subscriptionData = await docClient.send(new GetCommand({
          TableName: process.env.SUBSCRIPTIONS_TABLE!,
          Key: { userId }
        }));
        
        let subscription = subscriptionData.Item;
        
        // If no record, create the default credits billing record (balance 0)
        if (!subscription) {
          const now = new Date().toISOString();
          subscription = {
            userId,
            plan: 'credits',
            status: 'active',
            creditBalance: 0,
            autoRecharge: false,
            rechargeThreshold: 100,
            createdAt: now,
            updatedAt: now
          };

          await docClient.send(new UpdateCommand({
            TableName: process.env.SUBSCRIPTIONS_TABLE!,
            Key: { userId },
            UpdateExpression:
              'SET #plan = :plan, #status = :status, creditBalance = :balance, ' +
              'autoRecharge = :autoRecharge, rechargeThreshold = :threshold, ' +
              'createdAt = :createdAt, updatedAt = :updatedAt',
            ExpressionAttributeNames: {
              '#plan': 'plan',
              '#status': 'status'
            },
            ExpressionAttributeValues: {
              ':plan': 'credits',
              ':status': 'active',
              ':balance': 0,
              ':autoRecharge': false,
              ':threshold': 100,
              ':createdAt': now,
              ':updatedAt': now
            }
          }));
        }
        
        // Check if subscription is active
        if (subscription.status !== 'active') {
          return {
            statusCode: 402,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Credentials': true,
            },
            body: JSON.stringify({
              message: 'Subscription is not active',
              subscriptionStatus: subscription.status
            })
          };
        }
        
        // Get current month's usage
        const currentMonth = new Date().toISOString().substring(0, 7); // YYYY-MM format
        const usageData = await docClient.send(new GetCommand({
          TableName: process.env.USAGE_TABLE!,
          Key: { 
            userId,
            yearMonth: currentMonth
          }
        }));
        
        const usage = usageData.Item || {
          userId,
          yearMonth: currentMonth,
          pdfCount: 0,
          totalSizeMB: 0
        };
        
        // Attach subscription and usage to event
        handler.event.subscription = subscription;
        handler.event.subscriptionLimits =
          subscription.plan === 'enterprise'
            ? SUBSCRIPTION_PLANS.enterprise
            : SUBSCRIPTION_PLANS.credits;
        handler.event.currentUsage = usage;
        
      } catch (error) {
        console.error('Error checking subscription:', error);
        // Fail closed for credits: a DDB read error must not grant free PDFs
        handler.event.subscription = { plan: 'credits', status: 'active', creditBalance: 0 };
        handler.event.subscriptionLimits = SUBSCRIPTION_PLANS.credits;
        handler.event.currentUsage = { pdfCount: 0, totalSizeMB: 0 };
      }
    }
  };
};