#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ACCOUNT, getEnvConfig, REGION } from '../lib/config';
import { ApiStack } from '../lib/stacks/api-stack';
import { AuthStack } from '../lib/stacks/auth-stack';
import { DatabaseStack } from '../lib/stacks/database-stack';
import { JobsStack } from '../lib/stacks/jobs-stack';
import { StorageStack } from '../lib/stacks/storage-stack';

const app = new cdk.App();

const environmentName: string = app.node.tryGetContext('environment') ?? 'dev';
const cfg = getEnvConfig(environmentName);

const stackProps: cdk.StackProps = {
  env: { account: ACCOUNT, region: REGION },
  tags: {
    Project: 'mkpdfs',
    Environment: cfg.environment,
    ManagedBy: 'CDK',
  },
};

// 1. Stateful foundations (no dependencies)
const database = new DatabaseStack(app, `Mkpdfs-Database-${cfg.environment}`, {
  ...stackProps,
  description: `mkpdfs DynamoDB tables (${cfg.environment})`,
  cfg,
});

const storage = new StorageStack(app, `Mkpdfs-Storage-${cfg.environment}`, {
  ...stackProps,
  description: `mkpdfs assets bucket (${cfg.environment})`,
  cfg,
});

// 2. Auth (NEW pool, triggers attached natively; needs the users table)
const auth = new AuthStack(app, `Mkpdfs-Auth-${cfg.environment}`, {
  ...stackProps,
  description: `mkpdfs Cognito user/identity pools (${cfg.environment})`,
  cfg,
  usersTable: database.tables.users,
});

// 3. Jobs (queues + SQS processors)
const jobs = new JobsStack(app, `Mkpdfs-Jobs-${cfg.environment}`, {
  ...stackProps,
  description: `mkpdfs SQS queues + async processors (${cfg.environment})`,
  cfg,
  tables: database.tables,
  bucket: storage.bucket,
});

// 4. API (REST + 28 HTTP lambdas + custom domain)
new ApiStack(app, `Mkpdfs-Api-${cfg.environment}`, {
  ...stackProps,
  description: `mkpdfs REST API (${cfg.environment})`,
  cfg,
  tables: database.tables,
  bucket: storage.bucket,
  pdfGenerationQueue: jobs.pdfGenerationQueue,
  aiGenerationQueue: jobs.aiGenerationQueue,
  userPool: auth.userPool,
  userPoolClientId: auth.userPoolClient.userPoolClientId,
  identityPoolId: auth.identityPoolId,
});

app.synth();
