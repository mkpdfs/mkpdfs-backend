export default {
  handler: 'src/functions/cognito/preSignUp/handler.main',
  events: [
    {
      cognitoUserPool: {
        pool: 'mkpdfs-${self:provider.stage}-user-pool',
        trigger: 'PreSignUp' as const,
        existing: false
      }
    }
  ]
};
