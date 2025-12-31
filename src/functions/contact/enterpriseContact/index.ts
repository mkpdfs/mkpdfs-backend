export default {
  handler: 'src/functions/contact/enterpriseContact/handler.main',
  events: [
    {
      http: {
        method: 'post',
        path: 'contact/enterprise',
        cors: true
      }
    }
  ]
};
