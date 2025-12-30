export default {
  handler: 'src/functions/stripe/webhook/handler.main',
  events: [
    {
      http: {
        method: 'post',
        path: 'stripe/webhook',
        cors: true
        // No authorizer - Stripe verifies via signature
      }
    }
  ]
};
