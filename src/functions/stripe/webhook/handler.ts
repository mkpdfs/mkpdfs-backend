import type { APIGatewayProxyHandler, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { constructWebhookEvent, getStripe } from '@libs/services/stripeService';
import { creditFromStripePayment } from '@libs/services/creditService';
import type Stripe from 'stripe';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const handler: APIGatewayProxyHandler = async (event): Promise<APIGatewayProxyResult> => {
  const signature = event.headers['Stripe-Signature'] || event.headers['stripe-signature'];

  if (!signature) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Missing Stripe signature' }),
    };
  }

  let stripeEvent: Stripe.Event;

  try {
    // Stripe needs the raw body for signature verification
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body!, 'base64').toString('utf8')
      : event.body!;
    stripeEvent = await constructWebhookEvent(rawBody, signature);
  } catch (error: any) {
    console.error('Webhook signature verification failed:', error.message);
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: `Webhook Error: ${error.message}` }),
    };
  }

  console.log('Received Stripe event:', stripeEvent.type);

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object as Stripe.Checkout.Session;
        if (session.mode === 'payment') {
          await handlePurchaseCompleted(session);
        }
        break;
      }

      // Auto-recharge PIs only: purchase PIs are credited via the checkout
      // event (same idempotency key — paymentIntentId — so even event overlap
      // can't double-credit).
      case 'payment_intent.succeeded': {
        const pi = stripeEvent.data.object as Stripe.PaymentIntent;
        if (pi.metadata?.kind === 'auto_recharge') {
          await handleRechargeSucceeded(pi);
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = stripeEvent.data.object as Stripe.PaymentIntent;
        if (pi.metadata?.kind === 'auto_recharge') {
          await handleRechargeFailed(pi);
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${stripeEvent.type}`);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ received: true }),
    };
  } catch (error: any) {
    console.error('Error processing webhook:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};

async function handlePurchaseCompleted(session: Stripe.Checkout.Session) {
  const userId = session.metadata?.userId;
  if (!userId) {
    console.error('No userId in checkout session metadata');
    return;
  }
  const paymentIntentId = session.payment_intent as string;
  const customerId = session.customer as string;

  const { credited } = await creditFromStripePayment({
    userId,
    paymentIntentId,
    type: 'purchase',
  });
  console.log(`Purchase for user ${userId}: pi=${paymentIntentId} credited=${credited}`);

  // Persist plan/status/customer first — must land even if the payment-method
  // retrieve below hiccups (a throw here would make Stripe replay the event)
  await docClient.send(new UpdateCommand({
    TableName: process.env.SUBSCRIPTIONS_TABLE!,
    Key: { userId },
    UpdateExpression:
      'SET #plan = :plan, #status = :status, stripeCustomerId = :customerId, updatedAt = :now',
    ExpressionAttributeNames: { '#plan': 'plan', '#status': 'status' },
    ExpressionAttributeValues: {
      ':plan': 'credits',
      ':status': 'active',
      ':customerId': customerId,
      ':now': new Date().toISOString(),
    },
  }));

  // Save the card for future off-session auto-recharges (non-fatal: without
  // it the account simply can't arm auto-recharge until the next purchase)
  try {
    const stripe = await getStripe();
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    const paymentMethodId =
      typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method?.id;
    if (!paymentMethodId) {
      console.warn(`No payment_method on purchase PI ${paymentIntentId} — auto-recharge will not arm for user ${userId}`);
      return;
    }
    await docClient.send(new UpdateCommand({
      TableName: process.env.SUBSCRIPTIONS_TABLE!,
      Key: { userId },
      UpdateExpression: 'SET stripePaymentMethodId = :pm, updatedAt = :now',
      ExpressionAttributeValues: { ':pm': paymentMethodId, ':now': new Date().toISOString() },
    }));
  } catch (error) {
    console.error(`Failed to save payment method for user ${userId} (auto-recharge will not arm):`, error);
  }
}

async function handleRechargeSucceeded(pi: Stripe.PaymentIntent) {
  const userId = pi.metadata.userId;
  if (!userId) {
    console.error('No userId in recharge PaymentIntent metadata');
    return;
  }
  const { credited } = await creditFromStripePayment({
    userId,
    paymentIntentId: pi.id,
    type: 'auto_recharge',
  });
  console.log(`Auto-recharge for user ${userId}: pi=${pi.id} credited=${credited}`);

  await docClient.send(new UpdateCommand({
    TableName: process.env.SUBSCRIPTIONS_TABLE!,
    Key: { userId },
    UpdateExpression: 'SET rechargeInProgress = :false, updatedAt = :now REMOVE autoRechargeError',
    ExpressionAttributeValues: { ':false': false, ':now': new Date().toISOString() },
  }));
}

async function handleRechargeFailed(pi: Stripe.PaymentIntent) {
  const userId = pi.metadata.userId;
  if (!userId) {
    console.error('No userId in failed recharge PaymentIntent metadata');
    return;
  }
  const message = pi.last_payment_error?.message || 'Payment failed';
  console.log(`Auto-recharge FAILED for user ${userId}: ${message}`);

  // Disable auto-recharge so we don't retry-charge a bad card; the UI shows
  // a banner and the user re-enables after updating the card.
  await docClient.send(new UpdateCommand({
    TableName: process.env.SUBSCRIPTIONS_TABLE!,
    Key: { userId },
    UpdateExpression:
      'SET rechargeInProgress = :false, autoRecharge = :false, autoRechargeError = :msg, updatedAt = :now',
    ExpressionAttributeValues: {
      ':false': false,
      ':msg': message,
      ':now': new Date().toISOString(),
    },
  }));
}

export const main = handler;
