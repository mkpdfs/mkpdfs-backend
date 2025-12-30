export default {
  handler: 'src/functions/stripe/createPortalSession/handler.main',
  events: [
    {
      http: {
        method: 'post',
        path: 'stripe/create-portal-session',
        authorizer: 'aws_iam',
        cors: true
      }
    }
  ]
};
