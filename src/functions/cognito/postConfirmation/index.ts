export default {
  handler: 'src/functions/cognito/postConfirmation/handler.main',
  // No events - triggered by Cognito via LambdaConfig
  environment: {
    USERS_TABLE: 'templify-${self:provider.stage}-users'
  }
};
