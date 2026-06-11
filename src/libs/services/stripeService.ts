import Stripe from 'stripe';
import { getSsmParameter } from '@libs/ssmParams';

// Lazy Stripe client (initialized on first use, cached per container).
//
// Secret resolution order:
// 1. STRIPE_SECRET_KEY        — legacy Serverless stack (deploy-time ${ssm:} value)
// 2. STRIPE_SECRET_KEY_PARAM  — CDK stack: SSM parameter NAME, resolved at
//    runtime so the secret never lives in the Lambda env in plaintext.
let stripeClient: Stripe | undefined;

export async function getStripe(): Promise<Stripe> {
  if (!stripeClient) {
    const key =
      process.env.STRIPE_SECRET_KEY ||
      (process.env.STRIPE_SECRET_KEY_PARAM
        ? await getSsmParameter(process.env.STRIPE_SECRET_KEY_PARAM)
        : undefined);
    if (!key) {
      throw new Error(
        'Stripe secret key is not configured (set STRIPE_SECRET_KEY or STRIPE_SECRET_KEY_PARAM)'
      );
    }
    stripeClient = new Stripe(key, {
      apiVersion: '2025-12-15.clover',
    });
  }
  return stripeClient;
}

async function getWebhookSecret(): Promise<string> {
  const secret =
    process.env.STRIPE_WEBHOOK_SECRET ||
    (process.env.STRIPE_WEBHOOK_SECRET_PARAM
      ? await getSsmParameter(process.env.STRIPE_WEBHOOK_SECRET_PARAM)
      : undefined);
  if (!secret) {
    throw new Error(
      'Stripe webhook secret is not configured (set STRIPE_WEBHOOK_SECRET or STRIPE_WEBHOOK_SECRET_PARAM)'
    );
  }
  return secret;
}

// Map Stripe price IDs to plan names
export const PRICE_TO_PLAN: Record<string, string> = {
  [process.env.STRIPE_PRICE_BASIC!]: 'starter',
  [process.env.STRIPE_PRICE_PROFESSIONAL!]: 'professional',
};

// Map plan names to Stripe price IDs
export const PLAN_TO_PRICE: Record<string, string> = {
  starter: process.env.STRIPE_PRICE_BASIC!,
  basic: process.env.STRIPE_PRICE_BASIC!,
  professional: process.env.STRIPE_PRICE_PROFESSIONAL!,
};

export interface CreateCheckoutSessionParams {
  userId: string;
  userEmail: string;
  priceId: string;
  stripeCustomerId?: string;
}

export async function createCheckoutSession({
  userId,
  userEmail,
  priceId,
  stripeCustomerId,
}: CreateCheckoutSessionParams): Promise<Stripe.Checkout.Session> {
  const frontendUrl = process.env.FRONTEND_URL!;
  const stripe = await getStripe();

  // Create or reuse Stripe customer
  let customerId = stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: userEmail,
      metadata: {
        userId,
      },
    });
    customerId = customer.id;
  }

  // Create checkout session
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    payment_method_types: ['card'],
    allow_promotion_codes: true,
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    success_url: `${frontendUrl}/en/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendUrl}/en/billing/cancel`,
    metadata: {
      userId,
    },
    subscription_data: {
      metadata: {
        userId,
      },
    },
  });

  return session;
}

export async function createPortalSession(
  stripeCustomerId: string
): Promise<Stripe.BillingPortal.Session> {
  const frontendUrl = process.env.FRONTEND_URL!;
  const stripe = await getStripe();

  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: `${frontendUrl}/en/billing`,
  });

  return session;
}

export async function constructWebhookEvent(
  payload: string | Buffer,
  signature: string
): Promise<Stripe.Event> {
  const stripe = await getStripe();
  return stripe.webhooks.constructEvent(payload, signature, await getWebhookSecret());
}

export async function getSubscription(
  subscriptionId: string
): Promise<Stripe.Subscription> {
  const stripe = await getStripe();
  return stripe.subscriptions.retrieve(subscriptionId);
}

export async function getCustomer(
  customerId: string
): Promise<Stripe.Customer | Stripe.DeletedCustomer> {
  const stripe = await getStripe();
  return stripe.customers.retrieve(customerId);
}
