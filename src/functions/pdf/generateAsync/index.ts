export default {
  handler: 'src/functions/pdf/generateAsync/handler.main',
  layers: [
    '${self:custom.chromiumLayerArn}'
  ],
  timeout: 60,
  memorySize: 2048,
  events: [
    {
      http: {
        method: 'post',
        path: 'pdf/generate-async',
        authorizer: {
          type: 'COGNITO_USER_POOLS',
          authorizerId: { Ref: 'ApiGatewayAuthorizer' }
        },
        cors: true
      }
    }
  ]
};