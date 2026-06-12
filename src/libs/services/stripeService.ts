import Stripe from 'stripe';
import { getSsmParameter } from '@libs/ssmParams';
import { CREDITS_PER_PACK, PACK_PRICE_CENTS } from '../creditConstants';

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

export interface CreateCheckoutSessionParams {
  userId: string;
  userEmail: string;
  stripeCustomerId?: string;
}

/**
 * One-time payment for a credit pack. setup_future_usage saves the card so
 * auto-recharge can charge off-session later without a separate card flow.
 */
export async function createCheckoutSession({
  userId,
  userEmail,
  stripeCustomerId,
}: CreateCheckoutSessionParams): Promise<Stripe.Checkout.Session> {
  const frontendUrl = process.env.FRONTEND_URL!;
  const stripe = await getStripe();

  let customerId = stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: userEmail,
      metadata: { userId },
    });
    customerId = customer.id;
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'payment',
    payment_method_types: ['card'],
    allow_promotion_codes: true,
    line_items: [
      {
        price: process.env.STRIPE_PRICE_CREDITS_1000!,
        quantity: 1,
      },
    ],
    payment_intent_data: {
      setup_future_usage: 'off_session',
      metadata: { userId, kind: 'purchase' },
    },
    success_url: `${frontendUrl}/en/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendUrl}/en/billing/cancel`,
    metadata: { userId, kind: 'purchase' },
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

export async function getCustomer(
  customerId: string
): Promise<Stripe.Customer | Stripe.DeletedCustomer> {
  const stripe = await getStripe();
  return stripe.customers.retrieve(customerId);
}

/**
 * Off-session $10 charge for auto-recharge. Prefers the customer's default
 * payment method (the Stripe portal updates that) and falls back to the card
 * saved at first purchase. Card declines throw — the payment_failed webhook
 * handles disabling autoRecharge.
 */
export async function createRechargePaymentIntent(params: {
  userId: string;
  customerId: string;
  paymentMethodId: string;
}): Promise<Stripe.PaymentIntent> {
  const stripe = await getStripe();
  const retrieved = await stripe.customers.retrieve(params.customerId);
  const cust =
    'deleted' in retrieved && retrieved.deleted ? undefined : (retrieved as Stripe.Customer);
  const defaultPm =
    cust && typeof cust.invoice_settings?.default_payment_method === 'string'
      ? cust.invoice_settings.default_payment_method
      : undefined;

  return stripe.paymentIntents.create({
    amount: PACK_PRICE_CENTS,
    currency: 'usd',
    customer: params.customerId,
    payment_method: defaultPm ?? params.paymentMethodId,
    off_session: true,
    confirm: true,
    description: `mkpdfs auto-recharge: ${CREDITS_PER_PACK} PDF credits`,
    metadata: { userId: params.userId, kind: 'auto_recharge' },
  });
}
