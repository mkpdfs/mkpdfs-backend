export default {
  handler: 'src/functions/jobs/submit/handler.main',
  timeout: 30,
  memorySize: 256,
  events: [
    {
      http: {
        method: 'post',
        path: 'jobs/submit',
        authorizer: {
          type: 'COGNITO_USER_POOLS',
          authorizerId: { Ref: 'ApiGatewayAuthorizer' }
        },
        cors: true
      }
    }
  ]
};
