export default {
  handler: 'src/functions/templates/updateTemplate/handler.main',
  events: [
    {
      http: {
        method: 'put',
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
