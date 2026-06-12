import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  creditFromStripePayment,
  debitCredits,
  maybeTriggerAutoRecharge,
} from './creditService';

vi.mock('./stripeService', () => ({
  createRechargePaymentIntent: vi.fn().mockResolvedValue({ id: 'pi_test' }),
}));
import { createRechargePaymentIntent } from './stripeService';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
  vi.clearAllMocks();
  process.env.SUBSCRIPTIONS_TABLE = 'subs';
  process.env.CREDIT_LEDGER_TABLE = 'ledger';
});

describe('creditFromStripePayment', () => {
  it('writes ledger + balance in one transaction and reports credited', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    const res = await creditFromStripePayment({
      userId: 'u1', paymentIntentId: 'pi_1', type: 'purchase',
    });
    expect(res.credited).toBe(true);
    const tx = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
    expect(tx.TransactItems).toHaveLength(2);
    expect(tx.TransactItems![0].Put!.Item!.entryId).toBe('stripe#pi_1');
    expect(tx.TransactItems![0].Put!.ConditionExpression).toContain('attribute_not_exists');
    expect(tx.TransactItems![1].Update!.ExpressionAttributeValues![':amount']).toBe(1000);
  });

  it('is idempotent: a duplicate webhook delivery is a no-op', async () => {
    const err: any = new Error('cancelled');
    err.name = 'TransactionCanceledException';
    err.CancellationReasons = [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }];
    ddbMock.on(TransactWriteCommand).rejects(err);
    const res = await creditFromStripePayment({
      userId: 'u1', paymentIntentId: 'pi_1', type: 'purchase',
    });
    expect(res.credited).toBe(false);
  });
});

describe('debitCredits', () => {
  it('decrements atomically and writes a ledger entry with balanceAfter', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { creditBalance: 990 } });
    ddbMock.on(PutCommand).resolves({});
    const after = await debitCredits({ userId: 'u1', amount: 10, description: 'pdf_generation' });
    expect(after).toBe(990);
    const update = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(update.ExpressionAttributeValues![':neg']).toBe(-10);
    const put = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(put.Item!.type).toBe('debit');
    expect(put.Item!.balanceAfter).toBe(990);
  });
});

describe('maybeTriggerAutoRecharge', () => {
  const billing = {
    userId: 'u1', plan: 'credits', status: 'active',
    autoRecharge: true, rechargeThreshold: 100,
    stripeCustomerId: 'cus_1', stripePaymentMethodId: 'pm_1',
  };

  it('does nothing when balance is above threshold', async () => {
    await maybeTriggerAutoRecharge({ billing, balanceAfter: 100 });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('does nothing when autoRecharge is off', async () => {
    await maybeTriggerAutoRecharge({ billing: { ...billing, autoRecharge: false }, balanceAfter: 5 });
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('takes the lock and creates the off-session PaymentIntent', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await maybeTriggerAutoRecharge({ billing, balanceAfter: 50 });
    const lock = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(lock.ConditionExpression).toContain('rechargeInProgress');
    expect(createRechargePaymentIntent).toHaveBeenCalledWith({
      userId: 'u1', customerId: 'cus_1', paymentMethodId: 'pm_1',
    });
  });

  it('is silent when another request already holds the lock', async () => {
    const err: any = new Error('cond');
    err.name = 'ConditionalCheckFailedException';
    ddbMock.on(UpdateCommand).rejects(err);
    await maybeTriggerAutoRecharge({ billing, balanceAfter: 50 });
    expect(createRechargePaymentIntent).not.toHaveBeenCalled();
  });

  it('clears the lock if the Stripe call throws', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    (createRechargePaymentIntent as any).mockRejectedValueOnce(new Error('stripe down'));
    await maybeTriggerAutoRecharge({ billing, balanceAfter: 50 });
    const updates = ddbMock.commandCalls(UpdateCommand);
    expect(updates).toHaveLength(2); // lock + clear
    expect(updates[1].args[0].input.ExpressionAttributeValues![':false']).toBe(false);
  });
});
