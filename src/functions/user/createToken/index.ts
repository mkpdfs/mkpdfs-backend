export default {
  handler: 'src/functions/user/createToken/handler.main',
  events: [
    {
      http: {
        method: 'post',
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