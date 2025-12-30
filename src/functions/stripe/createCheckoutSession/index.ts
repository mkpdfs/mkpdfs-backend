export default {
  handler: 'src/functions/stripe/createCheckoutSession/handler.main',
  events: [
    {
      http: {
        method: 'post',
        path: 'stripe/create-checkout-session',
        authorizer: 'aws_iam',
        cors: true
      }
    }
  ]
};
