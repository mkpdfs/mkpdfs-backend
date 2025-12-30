import type { APIGatewayProxyHandler, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { constructWebhookEvent, getSubscription, PRICE_TO_PLAN } from '@libs/services/stripeService';
import type Stripe from 'stripe';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const handler: APIGatewayProxyHandler = async (event): Promise<APIGatewayProxyResult> => {
  const signature = event.headers['Stripe-Signature'] || event.headers['stripe-signature'];

  if (!signature) {
    return {
      statusCode: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
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
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: `Webhook Error: ${error.message}` }),
    };
  }

  console.log('Received Stripe event:', stripeEvent.type);

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object as Stripe.Checkout.Session;
        await handleCheckoutCompleted(session);
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = stripeEvent.data.object as Stripe.Subscription;
        await handleSubscriptionUpdated(subscription);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = stripeEvent.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(subscription);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object as Stripe.Invoice;
        await handlePaymentFailed(invoice);
        break;
      }

      default:
        console.log(`Unhandled event type: ${stripeEvent.type}`);
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ received: true }),
    };
  } catch (error: any) {
    console.error('Error processing webhook:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const userId = session.metadata?.userId;
  if (!userId) {
    console.error('No userId in checkout session metadata');
    return;
  }

  const subscriptionId = session.subscription as string;
  const customerId = session.customer as string;

  // Get subscription details to determine the plan
  const subscription = await getSubscription(subscriptionId);
  const priceId = subscription.items.data[0]?.price.id;
  const plan = PRICE_TO_PLAN[priceId] || 'starter';

  console.log(`Checkout completed for user ${userId}, plan: ${plan}`);

  // Update subscription in DynamoDB
  await docClient.send(new UpdateCommand({
    TableName: process.env.SUBSCRIPTIONS_TABLE!,
    Key: { userId },
    UpdateExpression: `
      SET #plan = :plan,
          #status = :status,
          stripeCustomerId = :customerId,
          stripeSubscriptionId = :subscriptionId,
          stripePriceId = :priceId,
          updatedAt = :updatedAt
    `,
    ExpressionAttributeNames: {
      '#plan': 'plan',
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':plan': plan,
      ':status': 'active',
      ':customerId': customerId,
      ':subscriptionId': subscriptionId,
      ':priceId': priceId,
      ':updatedAt': new Date().toISOString(),
    },
  }));
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  const userId = subscription.metadata?.userId;
  if (!userId) {
    console.error('No userId in subscription metadata');
    return;
  }

  const priceId = subscription.items.data[0]?.price.id;
  const plan = PRICE_TO_PLAN[priceId] || 'starter';
  const status = subscription.status === 'active' ? 'active' :
                 subscription.status === 'past_due' ? 'past_due' : 'cancelled';

  console.log(`Subscription updated for user ${userId}, plan: ${plan}, status: ${status}`);

  await docClient.send(new UpdateCommand({
    TableName: process.env.SUBSCRIPTIONS_TABLE!,
    Key: { userId },
    UpdateExpression: `
      SET #plan = :plan,
          #status = :status,
          stripePriceId = :priceId,
          updatedAt = :updatedAt
    `,
    ExpressionAttributeNames: {
      '#plan': 'plan',
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':plan': plan,
      ':status': status,
      ':priceId': priceId,
      ':updatedAt': new Date().toISOString(),
    },
  }));
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const userId = subscription.metadata?.userId;
  if (!userId) {
    console.error('No userId in subscription metadata');
    return;
  }

  console.log(`Subscription cancelled for user ${userId}`);

  // Downgrade to free plan
  await docClient.send(new UpdateCommand({
    TableName: process.env.SUBSCRIPTIONS_TABLE!,
    Key: { userId },
    UpdateExpression: `
      SET #plan = :plan,
          #status = :status,
          stripeSubscriptionId = :null,
          stripePriceId = :null,
          updatedAt = :updatedAt
    `,
    ExpressionAttributeNames: {
      '#plan': 'plan',
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':plan': 'free',
      ':status': 'active',
      ':null': null,
      ':updatedAt': new Date().toISOString(),
    },
  }));
}

async function handlePaymentFailed(invoice: Stripe.Invoice) {
  const customerId = invoice.customer as string;

  // Find user by Stripe customer ID (would need a GSI, for now we'll log)
  console.log(`Payment failed for customer ${customerId}`);

  // In production, you'd query by stripeCustomerId GSI and update status
  // For now, we rely on subscription.updated event which Stripe also sends
}

export const main = handler;
