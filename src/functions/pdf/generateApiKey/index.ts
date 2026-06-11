export default {
  handler: 'src/functions/pdf/generateApiKey/handler.main',
  layers: [
    '${self:custom.chromiumLayerArn}'
  ],
  timeout: 30,
  memorySize: 2048,
  events: [
    {
      http: {
        method: 'post',
        path: 'v1/pdf/generate',
        // Deliberately NO Gateway authorizer: this is the server-to-server
        // route. Auth is enforced in-lambda by apiKeyOnlyMiddleware
        // (x-api-key: tlfy_* only; Bearer JWTs rejected).
        cors: true
      }
    }
  ]
};
