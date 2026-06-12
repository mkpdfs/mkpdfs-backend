import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@libs/services/creditService', () => ({
  debitCredits: vi.fn().mockResolvedValue(990),
  maybeTriggerAutoRecharge: vi.fn().mockResolvedValue(undefined),
}));
import { debitCredits, maybeTriggerAutoRecharge } from '@libs/services/creditService';
import { checkCreditsMiddleware, debitCreditsMiddleware } from './credits';

beforeEach(() => vi.clearAllMocks());

const makeHandler = (over: any = {}) => ({
  event: {
    userId: 'u1',
    subscription: { userId: 'u1', plan: 'credits', status: 'active', creditBalance: 5 },
    body: { data: [{}, {}, {}] }, // 3 pages
    ...over.event,
  },
  response: over.response,
});

describe('checkCreditsMiddleware', () => {
  it('lets the request through when balance covers the pages', async () => {
    const h = makeHandler();
    expect(await checkCreditsMiddleware().before(h)).toBeUndefined();
  });

  it('returns 402 with creditsRemaining when balance is insufficient', async () => {
    const h = makeHandler({ event: { userId: 'u1', subscription: { plan: 'credits', creditBalance: 2 }, body: { data: [{}, {}, {}] } } });
    const res: any = await checkCreditsMiddleware().before(h);
    expect(res.statusCode).toBe(402);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('INSUFFICIENT_CREDITS');
    expect(body.creditsRemaining).toBe(2);
    expect(body.creditsRequested).toBe(3);
  });

  it('bypasses enterprise', async () => {
    const h = makeHandler({ event: { userId: 'u1', subscription: { plan: 'enterprise' }, body: { data: new Array(99).fill({}) } } });
    expect(await checkCreditsMiddleware().before(h)).toBeUndefined();
  });
});

describe('debitCreditsMiddleware', () => {
  it('debits pageCount and triggers auto-recharge check on 200', async () => {
    const h = makeHandler({ response: { statusCode: 200 } });
    h.event.pageCount = 3;
    await debitCreditsMiddleware().after(h);
    expect(debitCredits).toHaveBeenCalledWith({ userId: 'u1', amount: 3, description: 'pdf_generation' });
    expect(maybeTriggerAutoRecharge).toHaveBeenCalledWith({ billing: h.event.subscription, balanceAfter: 990 });
  });

  it('does not debit on non-200', async () => {
    const h = makeHandler({ response: { statusCode: 500 } });
    await debitCreditsMiddleware().after(h);
    expect(debitCredits).not.toHaveBeenCalled();
  });

  it('does not debit enterprise', async () => {
    const h = makeHandler({ response: { statusCode: 200 } });
    h.event.subscription.plan = 'enterprise';
    await debitCreditsMiddleware().after(h);
    expect(debitCredits).not.toHaveBeenCalled();
  });

  it('never fails the request if the debit throws', async () => {
    (debitCredits as any).mockRejectedValueOnce(new Error('ddb down'));
    const h = makeHandler({ response: { statusCode: 200 } });
    await expect(debitCreditsMiddleware().after(h)).resolves.toBeUndefined();
  });
});
