export default {
  handler: 'src/functions/pdf/generate/handler.main',
  layers: [
    { Ref: 'PuppeteerLambdaLayer' }
  ],
  timeout: 30,
  memorySize: 2048,
  events: [
    {
      http: {
        method: 'post',
        path: 'pdf/generate',
        authorizer: {
          type: 'COGNITO_USER_POOLS',
          authorizerId: { Ref: 'ApiGatewayAuthorizer' }
        },
        cors: true
      }
    }
  ]
};