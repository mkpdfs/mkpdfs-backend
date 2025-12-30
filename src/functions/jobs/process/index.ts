export default {
  handler: 'src/functions/jobs/process/handler.main',
  layers: [
    { Ref: 'PuppeteerLambdaLayer' }
  ],
  timeout: 300, // 5 minutes for PDF generation
  memorySize: 2048,
  reservedConcurrency: 10, // Limit concurrent executions
  events: [
    {
      sqs: {
        arn: { 'Fn::GetAtt': ['PdfGenerationQueue', 'Arn'] },
        batchSize: 1, // Process one at a time (PDF generation is resource intensive)
        maximumBatchingWindow: 0 // Process immediately
      }
    }
  ]
};
