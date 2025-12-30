export default {
  handler: 'src/functions/templates/listTemplates/handler.main',
  events: [
    {
      http: {
        method: 'get',
        path: 'templates',
        authorizer: {
          type: 'COGNITO_USER_POOLS',
          authorizerId: { Ref: 'ApiGatewayAuthorizer' }
        },
        cors: true
      }
    }
  ]
};