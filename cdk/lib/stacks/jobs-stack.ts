import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { CHROMIUM_LAYER_ARN, EnvConfig, queueNames } from '../config';
import {
  buildCommonEnv,
  createServiceFunction,
  grantBedrock,
  grantSes,
  grantSsmParams,
} from '../service-function';
import { MkpdfsTables } from './database-stack';

export interface JobsStackProps extends cdk.StackProps {
  cfg: EnvConfig;
  tables: MkpdfsTables;
  bucket: s3.Bucket;
}

/**
 * SQS queues (OWNED, same physical names/settings as inventory section (e))
 * + the two SQS processors (processJob / processAIGeneration).
 *
 * PIVOTE: event source mappings are ENABLED — the old stack dies before this
 * deploys, so there is no consumer coexistence to worry about.
 */
export class JobsStack extends cdk.Stack {
  public readonly pdfGenerationQueue: sqs.Queue;
  public readonly pdfGenerationDlq: sqs.Queue;
  public readonly aiGenerationQueue: sqs.Queue;
  public readonly aiGenerationDlq: sqs.Queue;
  public readonly processJobFn: lambdaNode.NodejsFunction;
  public readonly processAIGenerationFn: lambdaNode.NodejsFunction;

  constructor(scope: Construct, id: string, props: JobsStackProps) {
    super(scope, id, props);

    const { cfg, tables, bucket } = props;
    const names = queueNames(cfg.environment);
    // Queues are semi-stateful (in-flight jobs): RETAIN in prod, DESTROY in dev
    const removalPolicy = cfg.isProd
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.DESTROY;

    // -----------------------------------------------------------------
    // Queues (same names + visibility/retention/long-poll/redrive)
    // -----------------------------------------------------------------
    this.pdfGenerationDlq = new sqs.Queue(this, 'PdfGenerationDLQ', {
      queueName: names.pdfGenerationDlq,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy,
    });

    this.pdfGenerationQueue = new sqs.Queue(this, 'PdfGenerationQueue', {
      queueName: names.pdfGeneration,
      visibilityTimeout: cdk.Duration.seconds(360), // > processJob timeout (300s)
      retentionPeriod: cdk.Duration.days(4),
      receiveMessageWaitTime: cdk.Duration.seconds(20), // long polling
      deadLetterQueue: {
        queue: this.pdfGenerationDlq,
        maxReceiveCount: 3,
      },
      removalPolicy,
    });

    this.aiGenerationDlq = new sqs.Queue(this, 'AIGenerationDLQ', {
      queueName: names.aiGenerationDlq,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy,
    });

    this.aiGenerationQueue = new sqs.Queue(this, 'AIGenerationQueue', {
      queueName: names.aiGeneration,
      visibilityTimeout: cdk.Duration.seconds(600),
      retentionPeriod: cdk.Duration.days(4),
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      deadLetterQueue: {
        queue: this.aiGenerationDlq,
        maxReceiveCount: 2, // AI calls are expensive
      },
      removalPolicy,
    });

    // -----------------------------------------------------------------
    // Chromium layer (account-local, published outside any stack)
    // -----------------------------------------------------------------
    const chromiumLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      'ChromiumLayer',
      CHROMIUM_LAYER_ARN,
    );

    // Processors don't use the Cognito IDs; queue URLs from the owned queues
    // (enmienda 4)
    const env = buildCommonEnv(this, {
      cfg,
      queueUrls: {
        pdfGeneration: this.pdfGenerationQueue.queueUrl,
        aiGeneration: this.aiGenerationQueue.queueUrl,
      },
    });

    // -----------------------------------------------------------------
    // processJob — SQS consumer, PDF generation (puppeteer + layer)
    // -----------------------------------------------------------------
    this.processJobFn = createServiceFunction(this, 'ProcessJobFn', {
      entry: 'src/functions/jobs/process/handler.ts',
      timeoutSeconds: 300,
      memorySize: 4096, // Chromium render is CPU-bound; CPU scales with memory
      reservedConcurrentExecutions: 10,
      layers: [chromiumLayer],
      environment: env,
      description: 'SQS consumer: async PDF generation',
    });
    this.processJobFn.addEventSource(
      new SqsEventSource(this.pdfGenerationQueue, {
        batchSize: 1,
        enabled: true, // PIVOTE: no coexistence — old stack is gone
      }),
    );
    // jobs status updates + usage counters + template read/PDF write + email
    tables.jobs.grantReadWriteData(this.processJobFn);
    tables.usage.grantReadWriteData(this.processJobFn);
    tables.subscriptions.grantReadWriteData(this.processJobFn); // credit debit
    tables.creditLedger.grantWriteData(this.processJobFn);
    bucket.grantRead(this.processJobFn);
    bucket.grantPut(this.processJobFn);
    tables.templates.grantReadData(this.processJobFn); // pdfService reads the theme
    grantSes(this.processJobFn);
    grantSsmParams(this.processJobFn, cfg.environment); // stripe key for auto-recharge

    // -----------------------------------------------------------------
    // processAIGeneration — SQS consumer, Bedrock + thumbnail (layer)
    // -----------------------------------------------------------------
    this.processAIGenerationFn = createServiceFunction(this, 'ProcessAIGenerationFn', {
      entry: 'src/functions/ai/processGeneration/handler.ts',
      timeoutSeconds: 300,
      memorySize: 2048,
      reservedConcurrentExecutions: 5,
      layers: [chromiumLayer],
      environment: env,
      description: 'SQS consumer: AI template generation (Bedrock) + thumbnail',
    });
    this.processAIGenerationFn.addEventSource(
      new SqsEventSource(this.aiGenerationQueue, {
        batchSize: 1,
        enabled: true,
      }),
    );
    tables.aiJobs.grantReadWriteData(this.processAIGenerationFn);
    tables.usage.grantReadWriteData(this.processAIGenerationFn);
    bucket.grantRead(this.processAIGenerationFn); // uploaded reference images
    bucket.grantPut(this.processAIGenerationFn); // generated thumbnails
    grantBedrock(this.processAIGenerationFn);

    // -----------------------------------------------------------------
    // Outputs
    // -----------------------------------------------------------------
    new cdk.CfnOutput(this, 'PdfGenerationQueueName', {
      value: this.pdfGenerationQueue.queueName,
    });
    new cdk.CfnOutput(this, 'PdfGenerationQueueUrl', {
      value: this.pdfGenerationQueue.queueUrl,
    });
    new cdk.CfnOutput(this, 'PdfGenerationDlqName', {
      value: this.pdfGenerationDlq.queueName,
    });
    new cdk.CfnOutput(this, 'AIGenerationQueueName', {
      value: this.aiGenerationQueue.queueName,
    });
    new cdk.CfnOutput(this, 'AIGenerationQueueUrl', {
      value: this.aiGenerationQueue.queueUrl,
    });
    new cdk.CfnOutput(this, 'AIGenerationDlqName', {
      value: this.aiGenerationDlq.queueName,
    });
  }
}
