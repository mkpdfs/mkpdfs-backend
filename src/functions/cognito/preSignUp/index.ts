export default {
  handler: 'src/functions/cognito/preSignUp/handler.main',
  events: [
    {
      cognitoUserPool: {
        pool: 'CognitoUserPool',
        trigger: 'PreSignUp' as const,
        existing: true
      }
    }
  ]
};
