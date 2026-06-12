/**
 * Middleware to check AI generation limits before processing requests
 */
export const checkAILimitsMiddleware = () => {
  return {
    before: async (handler: any): Promise<any> => {
      const limits = handler.event.subscriptionLimits;
      const usage = handler.event.currentUsage;
      const subscription = handler.event.subscription;
      const plan = subscription?.plan || 'credits';

      // AI is included for anyone with a positive credit balance (enterprise always)
      if (plan !== 'enterprise' && (subscription?.creditBalance ?? 0) <= 0) {
        return {
          statusCode: 403,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Credentials': true,
          },
          body: JSON.stringify({
            success: false,
            error: 'INSUFFICIENT_CREDITS',
            message: 'AI Template Generation requires a positive credit balance. Buy a credit pack ($10 = 1,000 PDFs) to unlock it.',
            purchaseRequired: true
          })
        };
      }

      // Check monthly limit
      const currentGenerations = usage?.aiGenerations || 0;
      const limit = limits?.aiGenerationsPerMonth || 0;

      if (limit !== -1 && currentGenerations >= limit) {
        return {
          statusCode: 429,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Credentials': true,
          },
          body: JSON.stringify({
            success: false,
            error: 'LIMIT_EXCEEDED',
            message: `Monthly AI generation limit reached (${limit} per month)`,
            currentUsage: currentGenerations,
            limit,
            currentPlan: plan,
            remainingGenerations: 0
          })
        };
      }

      // Attach remaining count to event for response
      handler.event.aiGenerationsRemaining = limit === -1
        ? -1  // unlimited
        : limit - currentGenerations;
    }
  };
};
