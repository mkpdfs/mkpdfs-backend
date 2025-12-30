export default {
  handler: 'src/functions/ai/generateTemplate/handler.main',
  timeout: 60,  // AI generation may take longer
  memorySize: 1024,
  events: [
    {
      http: {
        method: 'post',
        path: 'ai/generate-template',
        authorizer: {
          type: 'COGNITO_USER_POOLS',
          authorizerId: { Ref: 'ApiGatewayAuthorizer' }
        },
        cors: true
      }
    }
  ]
};
