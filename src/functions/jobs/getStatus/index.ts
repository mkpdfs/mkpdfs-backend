export default {
  handler: 'src/functions/jobs/getStatus/handler.main',
  timeout: 10,
  memorySize: 256,
  events: [
    {
      http: {
        method: 'get',
        path: 'jobs/{jobId}',
        authorizer: {
          type: 'COGNITO_USER_POOLS',
          authorizerId: { Ref: 'ApiGatewayAuthorizer' }
        },
        cors: true
      }
    }
  ]
};
