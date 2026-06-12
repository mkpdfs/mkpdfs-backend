import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { EnvConfig, tableNames } from '../config';

export interface DatabaseStackProps extends cdk.StackProps {
  cfg: EnvConfig;
}

export interface MkpdfsTables {
  users: dynamodb.Table;
  tokens: dynamodb.Table;
  usage: dynamodb.Table;
  subscriptions: dynamodb.Table;
  templates: dynamodb.Table;
  marketplace: dynamodb.Table;
  jobs: dynamodb.Table;
  rateLimits: dynamodb.Table;
  aiJobs: dynamodb.Table;
  cliAuth: dynamodb.Table;
  creditLedger: dynamodb.Table;
}

/**
 * The 9 DynamoDB tables, OWNED by CDK with the same physical names, keys,
 * GSIs, TTL, stream and PITR settings as the Serverless stack they replace
 * (inventory section (b)). PIVOTE: greenfield with identical names — the old
 * stack is deleted before this deploys.
 *
 * RemovalPolicy: RETAIN in prod, DESTROY in dev (cheap insurance).
 */
export class DatabaseStack extends cdk.Stack {
  public readonly tables: MkpdfsTables;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    const { cfg } = props;
    const names = tableNames(cfg.environment);
    const removalPolicy = cfg.isProd
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.DESTROY;

    const common = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy,
    };

    const users = new dynamodb.Table(this, 'UsersTable', {
      ...common,
      tableName: names.users,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    users.addGlobalSecondaryIndex({
      indexName: 'email-index',
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const tokens = new dynamodb.Table(this, 'TokensTable', {
      ...common,
      tableName: names.tokens,
      partitionKey: { name: 'token', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
    });
    tokens.addGlobalSecondaryIndex({
      indexName: 'userId-index',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const usage = new dynamodb.Table(this, 'UsageTable', {
      ...common,
      tableName: names.usage,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'yearMonth', type: dynamodb.AttributeType.STRING },
    });

    const subscriptions = new dynamodb.Table(this, 'SubscriptionsTable', {
      ...common,
      tableName: names.subscriptions,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    const templates = new dynamodb.Table(this, 'TemplatesTable', {
      ...common,
      tableName: names.templates,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'templateId', type: dynamodb.AttributeType.STRING },
    });

    const marketplace = new dynamodb.Table(this, 'MarketplaceTable', {
      ...common,
      tableName: names.marketplace,
      partitionKey: { name: 'templateId', type: dynamodb.AttributeType.STRING },
    });
    marketplace.addGlobalSecondaryIndex({
      indexName: 'category-index',
      partitionKey: { name: 'category', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const jobs = new dynamodb.Table(this, 'JobsTable', {
      ...common,
      tableName: names.jobs,
      partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });
    jobs.addGlobalSecondaryIndex({
      indexName: 'userId-createdAt-index',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const rateLimits = new dynamodb.Table(this, 'RateLimitsTable', {
      ...common,
      tableName: names.rateLimits,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });

    const aiJobs = new dynamodb.Table(this, 'AIJobsTable', {
      ...common,
      tableName: names.aiJobs,
      partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });
    aiJobs.addGlobalSecondaryIndex({
      indexName: 'userId-createdAt-index',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const cliAuth = new dynamodb.Table(this, 'CliAuthTable', {
      ...common,
      tableName: names.cliAuth,
      partitionKey: { name: 'deviceCode', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });
    cliAuth.addGlobalSecondaryIndex({
      indexName: 'userCode-index',
      partitionKey: { name: 'userCode', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Credit ledger: audit trail + webhook idempotency (entryId is
    // `stripe#<paymentIntentId>` for credits, `<ISO>#<uuid>` for debits)
    const creditLedger = new dynamodb.Table(this, 'CreditLedgerTable', {
      ...common,
      tableName: names.creditLedger,
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'entryId', type: dynamodb.AttributeType.STRING },
    });

    this.tables = {
      users,
      tokens,
      usage,
      subscriptions,
      templates,
      marketplace,
      jobs,
      rateLimits,
      aiJobs,
      cliAuth,
      creditLedger,
    };

    for (const [key, table] of Object.entries(this.tables)) {
      new cdk.CfnOutput(this, `${key}TableName`, {
        value: table.tableName,
        description: `Physical name of the ${key} table`,
      });
    }
  }
}
