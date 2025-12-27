export default {
  handler: 'src/functions/cognito/postConfirmation/handler.main',
  events: [
    {
      cognitoUserPool: {
        pool: 'CognitoUserPool',
        trigger: 'PostConfirmation',
        existing: true
      }
    }
  ],
  environment: {
    USERS_TABLE: 'templify-${self:provider.stage}-users'
  }
};
