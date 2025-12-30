export default {
  handler: 'src/functions/user/listTokens/handler.main',
  events: [
    {
      http: {
        method: 'get',
        path: 'user/tokens',
        authorizer: {
          type: 'COGNITO_USER_POOLS',
          authorizerId: { Ref: 'ApiGatewayAuthorizer' }
        },
        cors: true
      }
    }
  ]
};