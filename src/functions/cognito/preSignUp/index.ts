export default {
  handler: 'src/functions/cognito/preSignUp/handler.main',
  events: [
    {
      cognitoUserPool: {
        pool: 'templify-${self:provider.stage}-user-pool',
        trigger: 'PreSignUp' as const,
        existing: true,
        forceDeploy: true
      }
    }
  ]
};
