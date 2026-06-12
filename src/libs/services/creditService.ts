import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { CREDITS_PER_PACK, DEFAULT_RECHARGE_THRESHOLD } from '../creditConstants';
import { createRechargePaymentIntent } from './stripeService';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const RECHARGE_LOCK_STALE_MS = 15 * 60 * 1000; // webhook normally clears the lock in seconds

export type CreditType = 'purchase' | 'auto_recharge';

export interface BillingRecord {
  userId: string;
  plan: string;
  status: string;
  creditBalance?: number;
  autoRecharge?: boolean;
  rechargeThreshold?: number;
  rechargeInProgress?: boolean;
  rechargeLockedAt?: string;
  stripeCustomerId?: string;
  stripePaymentMethodId?: string;
  autoRechargeError?: string;
}

/**
 * Idempotently credit a Stripe payment. A single transaction writes the
 * ledger entry (conditional — the dedup key is `stripe#<paymentIntentId>`)
 * and increments the balance, so a redelivered webhook credits exactly once
 * and a crash can never apply one half without the other.
 */
export async function creditFromStripePayment(params: {
  userId: string;
  paymentIntentId: string;
  type: CreditType;
  amount?: number;
}): Promise<{ credited: boolean }> {
  const amount = params.amount ?? CREDITS_PER_PACK;
  const now = new Date().toISOString();
  try {
    await docClient.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: process.env.CREDIT_LEDGER_TABLE!,
            Item: {
              userId: params.userId,
              entryId: `stripe#${params.paymentIntentId}`,
              type: params.type,
              amount,
              stripePaymentIntentId: params.paymentIntentId,
              createdAt: now,
            },
            ConditionExpression: 'attribute_not_exists(userId)',
          },
        },
        {
          Update: {
            TableName: process.env.SUBSCRIPTIONS_TABLE!,
            Key: { userId: params.userId },
            UpdateExpression: 'SET updatedAt = :now ADD creditBalance :amount',
            ExpressionAttributeValues: { ':now': now, ':amount': amount },
          },
        },
      ],
    }));
    return { credited: true };
  } catch (err: any) {
    if (
      err.name === 'TransactionCanceledException' &&
      err.CancellationReasons?.some((r: any) => r.Code === 'ConditionalCheckFailed')
    ) {
      console.log(`[credits] PaymentIntent ${params.paymentIntentId} already credited — skipping`);
      return { credited: false };
    }
    throw err;
  }
}

/** Atomic debit + ledger entry. Returns the balance after the debit. */
export async function debitCredits(params: {
  userId: string;
  amount: number;
  description: string;
}): Promise<number> {
  const now = new Date().toISOString();
  // No ConditionExpression: the 402 gate runs before the handler, and the
  // debit lands after success. Concurrent requests can briefly overdraw —
  // accepted for v1; ADD keeps the math consistent (balance can go negative).
  const result = await docClient.send(new UpdateCommand({
    TableName: process.env.SUBSCRIPTIONS_TABLE!,
    Key: { userId: params.userId },
    UpdateExpression: 'SET updatedAt = :now ADD creditBalance :neg',
    ExpressionAttributeValues: { ':now': now, ':neg': -params.amount },
    ReturnValues: 'UPDATED_NEW',
  }));
  const balanceAfter = (result.Attributes?.creditBalance as number) ?? 0;
  // Two writes, not a transaction: TransactWrite cannot return UPDATED_NEW,
  // and the ledger entry needs balanceAfter. A crash between the two loses
  // only the audit row — the balance itself stays correct. Accepted risk.
  await docClient.send(new PutCommand({
    TableName: process.env.CREDIT_LEDGER_TABLE!,
    Item: {
      userId: params.userId,
      entryId: `${now}#${uuidv4()}`,
      type: 'debit',
      amount: -params.amount,
      balanceAfter,
      description: params.description,
      createdAt: now,
    },
  }));
  return balanceAfter;
}

/**
 * Called after a debit. The rechargeInProgress conditional lock guarantees a
 * single in-flight PaymentIntent per user under concurrent debits; the
 * webhook (payment_intent.succeeded / payment_failed) clears the lock.
 */
export async function maybeTriggerAutoRecharge(params: {
  billing: BillingRecord;
  balanceAfter: number;
}): Promise<void> {
  const { billing, balanceAfter } = params;
  if (!billing.autoRecharge || !billing.stripeCustomerId || !billing.stripePaymentMethodId) {
    return;
  }
  const threshold = billing.rechargeThreshold ?? DEFAULT_RECHARGE_THRESHOLD;
  if (balanceAfter >= threshold) return;

  try {
    const nowIso = new Date().toISOString();
    const staleBefore = new Date(Date.now() - RECHARGE_LOCK_STALE_MS).toISOString();
    await docClient.send(new UpdateCommand({
      TableName: process.env.SUBSCRIPTIONS_TABLE!,
      Key: { userId: billing.userId },
      UpdateExpression: 'SET rechargeInProgress = :true, rechargeLockedAt = :now, updatedAt = :now',
      ConditionExpression:
        'attribute_not_exists(rechargeInProgress) OR rechargeInProgress = :false OR rechargeLockedAt < :staleBefore',
      ExpressionAttributeValues: {
        ':true': true,
        ':false': false,
        ':now': nowIso,
        ':staleBefore': staleBefore,
      },
    }));
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') return; // already in flight
    throw err;
  }

  try {
    await createRechargePaymentIntent({
      userId: billing.userId,
      customerId: billing.stripeCustomerId,
      paymentMethodId: billing.stripePaymentMethodId,
    });
  } catch (err) {
    // Card declines also land here (off-session confirm throws). The
    // payment_intent.payment_failed webhook disables autoRecharge; clearing
    // the lock here covers pure API failures where no PI was created.
    console.error('[credits] auto-recharge PaymentIntent failed:', err);
    await docClient.send(new UpdateCommand({
      TableName: process.env.SUBSCRIPTIONS_TABLE!,
      Key: { userId: billing.userId },
      UpdateExpression: 'SET rechargeInProgress = :false',
      ExpressionAttributeValues: { ':false': false },
    })).catch((e) => console.error('[credits] failed to clear recharge lock:', e));
  }
}

/**
 * Ledger entries, newest first. SK order is mixed (stripe#… vs ISO#…), so sort by createdAt.
 * Fetches the full partition (no Limit) because newest-first requires the createdAt sort;
 * fine at v1 volumes, revisit with pagination if ledgers grow large.
 */
export async function listLedgerEntries(userId: string, limit = 50) {
  const result = await docClient.send(new QueryCommand({
    TableName: process.env.CREDIT_LEDGER_TABLE!,
    KeyConditionExpression: 'userId = :userId',
    ExpressionAttributeValues: { ':userId': userId },
  }));
  const items = result.Items ?? [];
  items.sort((a, b) => ((a.createdAt as string) < (b.createdAt as string) ? 1 : -1));
  return items.slice(0, limit);
}
