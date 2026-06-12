import { debitCredits, maybeTriggerAutoRecharge } from '@libs/services/creditService';

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Credentials': true,
};

const pagesIn = (body: any): number =>
  body?.data && Array.isArray(body.data) ? body.data.length : 1;

/** 402 gate: requires subscriptionMiddleware to have run (event.subscription). */
export const checkCreditsMiddleware = () => ({
  before: async (handler: any): Promise<any> => {
    const sub = handler.event.subscription;
    if (!sub || sub.plan === 'enterprise') return;

    const creditsRequested = pagesIn(handler.event.body);
    const creditsRemaining = sub.creditBalance ?? 0;

    if (creditsRequested > creditsRemaining) {
      return {
        statusCode: 402,
        headers: corsHeaders,
        body: JSON.stringify({
          error: 'INSUFFICIENT_CREDITS',
          message:
            creditsRemaining <= 0
              ? 'You have no PDF credits. Buy a credit pack to continue ($10 = 1,000 PDFs).'
              : `Insufficient credits: ${creditsRemaining} remaining, ${creditsRequested} requested.`,
          creditsRemaining: Math.max(0, creditsRemaining),
          creditsRequested,
        }),
      };
    }
  },
});

/** Debit on HTTP 200 only (mirrors usageTrackingMiddleware), then check auto-recharge. */
export const debitCreditsMiddleware = () => ({
  after: async (handler: any): Promise<void> => {
    if (handler.response?.statusCode !== 200) return;
    const sub = handler.event.subscription;
    const userId = handler.event.userId;
    if (!userId || !sub || sub.plan === 'enterprise') return;

    const pageCount = handler.event.pageCount || 1;
    try {
      const balanceAfter = await debitCredits({
        userId,
        amount: pageCount,
        description: 'pdf_generation',
      });
      await maybeTriggerAutoRecharge({ billing: sub, balanceAfter });
    } catch (error) {
      console.error('[credits] debit failed (request NOT failed):', error);
    }
  },
});
