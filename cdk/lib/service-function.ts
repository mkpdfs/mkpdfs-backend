import * as path from 'path';
import { Duration } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import {
  ACCOUNT,
  EnvConfig,
  FROM_EMAIL,
  REGION,
  REPO_ROOT,
  SERVICE_NAME,
  bucketName,
  ssmParamNames,
  tableNames,
} from './config';

/**
 * Factory for the 32 service lambdas.
 *
 * Mirrors the serverless-esbuild surface: bundle (no minify), sourcemaps,
 * target node20, @sparticuz/chromium* external (the binary lives in the
 * layer; puppeteer-core gets bundled). No explicit functionName (CDK names
 * avoid any collision and survive logical moves). Each function gets its own
 * auto-generated role — grants are per-function, least privilege.
 */
export interface ServiceFunctionProps {
  /** Entry point relative to the repo root, e.g. 'src/functions/user/getProfile/handler.ts'. */
  entry: string;
  /** Seconds. Serverless default was 6. */
  timeoutSeconds?: number;
  /** MB. Serverless default was 1024. */
  memorySize?: number;
  environment: Record<string, string>;
  layers?: lambda.ILayerVersion[];
  reservedConcurrentExecutions?: number;
  description?: string;
}

export function createServiceFunction(
  scope: Construct,
  id: string,
  props: ServiceFunctionProps,
): lambdaNode.NodejsFunction {
  return new lambdaNode.NodejsFunction(scope, id, {
    entry: path.join(REPO_ROOT, props.entry),
    handler: 'main',
    runtime: lambda.Runtime.NODEJS_20_X,
    architecture: lambda.Architecture.X86_64, // chromium layer is x64
    timeout: Duration.seconds(props.timeoutSeconds ?? 6),
    memorySize: props.memorySize ?? 1024,
    // Spread: lambda.Function keeps the reference it receives, and
    // addEnvironment() would otherwise mutate the shared common-env object.
    environment: { ...props.environment },
    layers: props.layers,
    reservedConcurrentExecutions: props.reservedConcurrentExecutions,
    description: props.description,
    projectRoot: REPO_ROOT,
    depsLockFilePath: path.join(REPO_ROOT, 'package-lock.json'),
    bundling: {
      forceDockerBundling: false, // local esbuild (devDependency)
      minify: false,
      sourceMap: true,
      target: 'node20',
      // Same exclusion list as serverless-esbuild ('aws-sdk' v2 is unused;
      // @aws-sdk v3 stays BUNDLED for parity with the live builds).
      externalModules: ['@sparticuz/chromium', '@sparticuz/chromium-min'],
      tsconfig: path.join(REPO_ROOT, 'tsconfig.json'), // resolves @libs/* aliases
    },
  });
}

export interface CommonEnvOptions {
  cfg: EnvConfig;
  /**
   * Queue URLs from the owned queues (enmienda 4: always injected, never the
   * hardcoded-account fallback in the producers). Omitted for the Cognito
   * trigger lambdas (unused there) to keep stack dependencies acyclic.
   */
  queueUrls?: { pdfGeneration: string; aiGeneration: string };
  /**
   * Cognito IDs (tokens from the Auth stack). Omitted for the trigger
   * lambdas themselves (a pool that points at a lambda whose env points back
   * at the pool would be a CFN cycle) and for the SQS processors (unused).
   */
  cognito?: {
    userPoolId: string;
    userPoolClientId: string;
    identityPoolId: string;
  };
}

/**
 * Replicates the Serverless provider.environment surface for every lambda.
 * Differences (intentional, per enmiendas):
 * - STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET no longer hold plaintext
 *   values; the lambdas receive the SSM parameter NAME (`*_PARAM`) and
 *   resolve it at runtime with caching (src/libs/ssmParams.ts).
 * - Stripe price IDs (not secrets) keep deploy-time resolution via CFN
 *   SSM parameter, so the module-level PRICE_TO_PLAN maps keep working.
 */
export function buildCommonEnv(
  scope: Construct,
  opts: CommonEnvOptions,
): Record<string, string> {
  const { cfg } = opts;
  const env = cfg.environment;
  const tables = tableNames(env);
  const params = ssmParamNames(env);
  const common: Record<string, string> = {
    AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
    NODE_OPTIONS: '--enable-source-maps --stack-trace-limit=1000',
    STAGE: env,
    REGION,
    SERVICE_NAME,

    USERS_TABLE: tables.users,
    TOKENS_TABLE: tables.tokens,
    USAGE_TABLE: tables.usage,
    SUBSCRIPTIONS_TABLE: tables.subscriptions,
    TEMPLATES_TABLE: tables.templates,
    MARKETPLACE_TABLE: tables.marketplace,
    JOBS_TABLE: tables.jobs,
    RATE_LIMIT_TABLE: tables.rateLimits,
    AI_JOBS_TABLE: tables.aiJobs,

    ASSETS_BUCKET: bucketName(env),
    ASSETS_BUCKET_URL: `https://${bucketName(env)}.s3.${REGION}.amazonaws.com`,

    FROM_EMAIL,
    IS_OFFLINE: 'false',
    CHROMIUM_PATH: '',

    STRIPE_SECRET_KEY_PARAM: params.stripeSecretKey,
    STRIPE_WEBHOOK_SECRET_PARAM: params.stripeWebhookSecret,
    STRIPE_PRICE_BASIC: ssm.StringParameter.valueForStringParameter(
      scope,
      params.stripePriceBasic,
    ),
    STRIPE_PRICE_PROFESSIONAL: ssm.StringParameter.valueForStringParameter(
      scope,
      params.stripePriceProfessional,
    ),
    FRONTEND_URL: cfg.frontendUrl,
  };
  if (opts.queueUrls) {
    common.PDF_GENERATION_QUEUE_URL = opts.queueUrls.pdfGeneration;
    common.AI_GENERATION_QUEUE_URL = opts.queueUrls.aiGeneration;
  }
  if (opts.cognito) {
    common.USER_POOL_ID = opts.cognito.userPoolId;
    common.USER_POOL_CLIENT_ID = opts.cognito.userPoolClientId;
    common.IDENTITY_POOL_ID = opts.cognito.identityPoolId;
  }
  return common;
}

// ---------------------------------------------------------------------------
// Per-function grant helpers (least privilege; replaces the legacy mega-role)
// ---------------------------------------------------------------------------

/** ses:Send* on '*' — parity with the legacy role (SES has no resource-level identity here). */
export function grantSes(fn: lambda.Function): void {
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }),
  );
}

/** bedrock:InvokeModel on Claude foundation models + US cross-region inference profiles. */
export function grantBedrock(fn: lambda.Function): void {
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
        `arn:aws:bedrock:*:${ACCOUNT}:inference-profile/us.anthropic.claude-*`,
      ],
    }),
  );
}

/** ssm:GetParameter(s) scoped to /mkpdfs/{env}/* (Stripe + Twilio runtime params). */
export function grantSsmParams(fn: lambda.Function, environment: string): void {
  fn.addToRolePolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [
        `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/mkpdfs/${environment}/*`,
      ],
    }),
  );
}
