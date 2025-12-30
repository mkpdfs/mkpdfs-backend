export default {
  handler: 'src/functions/stripe/createPortalSession/handler.main',
  events: [
    {
      http: {
        method: 'post',
        path: 'stripe/create-portal-session',
        authorizer: {
          type: 'COGNITO_USER_POOLS',
          authorizerId: { Ref: 'ApiGatewayAuthorizer' }
        },
        cors: true
      }
    }
  ]
};
