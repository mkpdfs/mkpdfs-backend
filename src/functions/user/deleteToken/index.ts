export default {
  handler: 'src/functions/user/deleteToken/handler.main',
  events: [
    {
      http: {
        method: 'delete',
        path: 'user/tokens/{tokenId}',
        authorizer: {
          type: 'COGNITO_USER_POOLS',
          authorizerId: { Ref: 'ApiGatewayAuthorizer' }
        },
        cors: true
      }
    }
  ]
};