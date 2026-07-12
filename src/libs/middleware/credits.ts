import { debitCredits, maybeTriggerAutoRecharge } from '@libs/services/creditService';
import { perfOf } from '@libs/perf';

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
    perfOf(handler.event)?.mark('creditGate');
  },
});

/** Debit on HTTP 200 only (mirrors usageTrackingMiddleware), then check auto-recharge. */
export const debitCreditsMiddleware = () => ({
  after: async (handler: any): Promise<void> => {
    const perf = perfOf(handler.event);

    if (handler.response?.statusCode === 200) {
      const sub = handler.event.subscription;
      const userId = handler.event.userId;
      if (userId && sub && sub.plan !== 'enterprise') {
        const pageCount = handler.event.pageCount || 1;
        try {
          await (perf
            ? perf.span('debit', () => runDebit(userId, pageCount, sub))
            : runDebit(userId, pageCount, sub));
        } catch (error) {
          console.error('[credits] debit failed (request NOT failed):', error);
        }
      }
    }

    // This middleware only exists on the PDF billing chain, and its after-hook
    // is the last billing step — emit the request's perf line here (also for
    // 4xx/5xx responses: slow failures matter just as much).
    perf?.emit('pdf_generate', {
      status: handler.response?.statusCode,
      path: handler.event.path,
      pageCount: handler.event.pageCount || 1,
    });
  },
});

const runDebit = async (userId: string, pageCount: number, sub: any): Promise<void> => {
  const balanceAfter = await debitCredits({
    userId,
    amount: pageCount,
    description: 'pdf_generation',
  });
  await maybeTriggerAutoRecharge({ billing: sub, balanceAfter });
};
