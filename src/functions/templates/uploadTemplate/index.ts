export default {
  handler: 'src/functions/templates/uploadTemplate/handler.main',
  events: [
    {
      http: {
        method: 'post',
        path: 'templates/upload',
        authorizer: {
          type: 'COGNITO_USER_POOLS',
          authorizerId: { Ref: 'ApiGatewayAuthorizer' }
        },
        cors: true
      }
    }
  ]
};