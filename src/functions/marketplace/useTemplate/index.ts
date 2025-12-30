export default {
  handler: 'src/functions/marketplace/useTemplate/handler.main',
  events: [
    {
      http: {
        method: 'post',
        path: 'marketplace/templates/{templateId}/use',
        authorizer: {
          type: 'COGNITO_USER_POOLS',
          authorizerId: { Ref: 'ApiGatewayAuthorizer' }
        },
        cors: true
      }
    }
  ]
};
