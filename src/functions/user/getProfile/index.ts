export default {
  handler: 'src/functions/user/getProfile/handler.main',
  events: [
    {
      http: {
        method: 'get',
        path: 'user/profile',
        authorizer: {
          type: 'COGNITO_USER_POOLS',
          authorizerId: { Ref: 'ApiGatewayAuthorizer' }
        },
        cors: true
      }
    }
  ]
};