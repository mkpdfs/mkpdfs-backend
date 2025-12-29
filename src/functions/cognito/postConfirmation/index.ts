export default {
  handler: 'src/functions/cognito/postConfirmation/handler.main',
  events: [
    {
      cognitoUserPool: {
        pool: 'mkpdfs-${self:provider.stage}-user-pool',
        trigger: 'PostConfirmation' as const,
        existing: false
      }
    }
  ],
  environment: {
    USERS_TABLE: 'mkpdfs-${self:provider.stage}-users'
  }
};
