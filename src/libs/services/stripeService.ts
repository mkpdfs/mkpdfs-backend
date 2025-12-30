import Stripe from 'stripe';

// Initialize Stripe client
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-12-15.clover',
});

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
    success_url: `${frontendUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendUrl}/billing/cancel`,
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

  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: `${frontendUrl}/billing`,
  });

  return session;
}

export async function constructWebhookEvent(
  payload: string | Buffer,
  signature: string
): Promise<Stripe.Event> {
  return stripe.webhooks.constructEvent(
    payload,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET!
  );
}

export async function getSubscription(
  subscriptionId: string
): Promise<Stripe.Subscription> {
  return stripe.subscriptions.retrieve(subscriptionId);
}

export async function getCustomer(
  customerId: string
): Promise<Stripe.Customer | Stripe.DeletedCustomer> {
  return stripe.customers.retrieve(customerId);
}

export { stripe };
