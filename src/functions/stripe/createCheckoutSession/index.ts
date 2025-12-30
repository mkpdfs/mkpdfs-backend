export default {
  handler: 'src/functions/stripe/createCheckoutSession/handler.main',
  events: [
    {
      http: {
        method: 'post',
        path: 'stripe/create-checkout-session',
        authorizer: {
          type: 'COGNITO_USER_POOLS',
          authorizerId: { Ref: 'ApiGatewayAuthorizer' }
        },
        cors: true
      }
    }
  ]
};
