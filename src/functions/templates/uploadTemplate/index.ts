export default {
  handler: 'src/functions/templates/uploadTemplate/handler.main',
  events: [
    {
      http: {
        method: 'post',
        path: 'templates/upload',
        authorizer: 'aws_iam',
        cors: true
      }
    }
  ]
};