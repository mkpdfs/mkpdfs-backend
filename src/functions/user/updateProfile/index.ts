export default {
  handler: 'src/functions/user/updateProfile/handler.main',
  events: [
    {
      http: {
        method: 'put',
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