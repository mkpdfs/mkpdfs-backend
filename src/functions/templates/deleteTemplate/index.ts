export default {
  handler: 'src/functions/templates/deleteTemplate/handler.main',
  events: [
    {
      http: {
        method: 'delete',
        path: 'templates/{templateId}',
        authorizer: {
          type: 'COGNITO_USER_POOLS',
          authorizerId: { Ref: 'ApiGatewayAuthorizer' }
        },
        cors: true
      }
    }
  ]
};