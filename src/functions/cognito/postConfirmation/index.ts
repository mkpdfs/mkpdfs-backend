export default {
  handler: 'src/functions/cognito/postConfirmation/handler.main',
  environment: {
    USERS_TABLE: 'templify-${self:provider.stage}-users'
  }
};
