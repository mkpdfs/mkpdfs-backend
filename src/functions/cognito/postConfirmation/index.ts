export default {
  handler: 'src/functions/cognito/postConfirmation/handler.main',
  events: [
    {
      cognitoUserPool: {
        pool: 'templify-${self:provider.stage}-user-pool',
        trigger: 'PostConfirmation' as const,
        existing: true,
        forceDeploy: true
      }
    }
  ],
  environment: {
    USERS_TABLE: 'templify-${self:provider.stage}-users'
  }
};
