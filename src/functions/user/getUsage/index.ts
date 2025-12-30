export default {
  handler: 'src/functions/user/getUsage/handler.main',
  events: [
    {
      http: {
        method: 'get',
        path: 'user/usage',
        authorizer: {
          type: 'COGNITO_USER_POOLS',
          authorizerId: { Ref: 'ApiGatewayAuthorizer' }
        },
        cors: true
      }
    }
  ]
};