import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { WELCOME_CREDITS } from '../creditConstants';

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

export interface SubscriptionMiddlewareOptions {
  /**
   * Read the monthly usage row and attach `event.currentUsage`. Defaults to
   * true. PDF routes pass false: usage is statistics-only (never gates PDF
   * generation), so the extra DynamoDB read added latency to every render
   * for nothing (perf review 2026-07-11, P0). Consumers that DO need it:
   * aiLimits middleware and getProfile.
   */
  readUsage?: boolean;
}

export const subscriptionMiddleware = (options: SubscriptionMiddlewareOptions = {}) => {
  const { readUsage = true } = options;
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
        
        // If no record, create the default credits billing record. New
        // accounts get WELCOME_CREDITS free pages (no ledger entry: most
        // routes lack ledger-table grants; the grant is implicit in creation)
        if (!subscription) {
          const now = new Date().toISOString();
          subscription = {
            userId,
            plan: 'credits',
            status: 'active',
            creditBalance: WELCOME_CREDITS,
            autoRecharge: false,
            rechargeThreshold: 100,
            createdAt: now,
            updatedAt: now
          };

          try {
            await docClient.send(new UpdateCommand({
              TableName: process.env.SUBSCRIPTIONS_TABLE!,
              Key: { userId },
              UpdateExpression:
                'SET #plan = :plan, #status = :status, creditBalance = :balance, ' +
                'autoRecharge = :autoRecharge, rechargeThreshold = :threshold, ' +
                'createdAt = :createdAt, updatedAt = :updatedAt',
              ConditionExpression: 'attribute_not_exists(userId)',
              ExpressionAttributeNames: {
                '#plan': 'plan',
                '#status': 'status'
              },
              ExpressionAttributeValues: {
                ':plan': 'credits',
                ':status': 'active',
                ':balance': WELCOME_CREDITS,
                ':autoRecharge': false,
                ':threshold': 100,
                ':createdAt': now,
                ':updatedAt': now
              }
            }));
          } catch (err: any) {
            if (err.name === 'ConditionalCheckFailedException') {
              // Lost the create race (concurrent request or webhook credit
              // landed first) — re-read instead of clobbering the real row
              const reread = await docClient.send(new GetCommand({
                TableName: process.env.SUBSCRIPTIONS_TABLE!,
                Key: { userId }
              }));
              subscription = reread.Item || subscription;
            } else {
              throw err;
            }
          }
        }
        
        // A row created by a webhook credit before the user's first request
        // has no status attribute — treat missing status as active
        if (subscription.status && subscription.status !== 'active') {
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
        
        if (readUsage) {
          // Get current month's usage
          const currentMonth = new Date().toISOString().substring(0, 7); // YYYY-MM format
          const usageData = await docClient.send(new GetCommand({
            TableName: process.env.USAGE_TABLE!,
            Key: {
              userId,
              yearMonth: currentMonth
            }
          }));

          handler.event.currentUsage = usageData.Item || {
            userId,
            yearMonth: currentMonth,
            pdfCount: 0,
            totalSizeMB: 0
          };
        }

        // Attach subscription to event
        handler.event.subscription = subscription;
        handler.event.subscriptionLimits =
          subscription.plan === 'enterprise'
            ? SUBSCRIPTION_PLANS.enterprise
            : SUBSCRIPTION_PLANS.credits;

      } catch (error) {
        console.error('Error checking subscription:', error);
        // Fail closed for credits: a DDB read error must not grant free PDFs
        handler.event.subscription = { plan: 'credits', status: 'active', creditBalance: 0 };
        handler.event.subscriptionLimits = SUBSCRIPTION_PLANS.credits;
        if (readUsage) {
          handler.event.currentUsage = { pdfCount: 0, totalSizeMB: 0 };
        }
      }
      handler.event.__perf?.mark?.('subscription');
    }
  };
};