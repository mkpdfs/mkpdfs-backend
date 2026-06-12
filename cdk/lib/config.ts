import * as path from 'path';

/**
 * Static configuration for the mkpdfs CDK app.
 *
 * Source of truth: docs/cdk-migration-plan.md (inventory verified against the
 * live account 197837191835 on 2026-06-10) + the PIVOTE section (CDK owns all
 * resources, same physical names as the Serverless stack it replaces).
 */

export type EnvironmentName = 'dev' | 'prod';

export const ACCOUNT = '197837191835';
export const REGION = 'us-east-1';

/** Kept for the legacy self-invoke fallback in src/functions/pdf/generate (enmienda 3). */
export const SERVICE_NAME = 'mkpdfs-api';

export const HOSTED_ZONE_ID = 'Z0217803KO361QOLBIHN';
export const HOSTED_ZONE_NAME = 'mkpdfs.com';

/**
 * Chromium layer published once from s3://mkpdfs-prod-bucket/lambda-layers/
 * (Sparticuz v143 x64). NOT managed by any stack — layers survive stack
 * deletion (PIVOTE item 6). Shared by dev+prod.
 */
export const CHROMIUM_LAYER_ARN =
  'arn:aws:lambda:us-east-1:197837191835:layer:mkpdfs-chromium:1';

export const FROM_EMAIL = 'noreply@mkpdfs.com';

/** Repo root (this file lives in cdk/lib/). Lambda entries resolve from here. */
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

export interface EnvConfig {
  environment: EnvironmentName;
  isProd: boolean;
  frontendUrl: string;
  /** Custom API domain (edge-optimized, managed by CDK per the PIVOTE). */
  apiDomainName: string;
  /** Existing ACM cert for the API custom domain (us-east-1). */
  certificateArn: string;
  /** Cognito Hosted UI domain prefix. */
  hostedUiDomainPrefix: string;
  /** OAuth callback/logout URLs. dev additionally gets dev.mkpdfs.com (fixes the gap in the legacy pool). */
  callbackUrls: string[];
  logoutUrls: string[];
}

export function getEnvConfig(environment: string): EnvConfig {
  if (environment !== 'dev' && environment !== 'prod') {
    throw new Error(
      `Unknown environment "${environment}". Use -c environment=dev|prod`,
    );
  }
  const isProd = environment === 'prod';
  const callbackUrls = [
    'http://localhost:3000/callback',
    'https://mkpdfs.com/callback',
    ...(isProd
      ? []
      : ['https://dev.mkpdfs.com/callback', 'http://localhost:3003/callback']),
  ];
  const logoutUrls = [
    'http://localhost:3000/logout',
    'https://mkpdfs.com/logout',
    ...(isProd
      ? []
      : ['https://dev.mkpdfs.com/logout', 'http://localhost:3003/logout']),
  ];
  return {
    environment,
    isProd,
    frontendUrl: isProd ? 'https://mkpdfs.com' : 'https://dev.mkpdfs.com',
    apiDomainName: isProd ? 'apis.mkpdfs.com' : 'dev.apis.mkpdfs.com',
    certificateArn: isProd
      ? `arn:aws:acm:${REGION}:${ACCOUNT}:certificate/cbc979b6-0d23-4997-bb6e-0ee72ac3557a`
      : `arn:aws:acm:${REGION}:${ACCOUNT}:certificate/1a16de41-d72e-4c71-8cff-f678dc9ea6b3`,
    hostedUiDomainPrefix: `auth-mkpdfs-${environment}`,
    callbackUrls,
    logoutUrls,
  };
}

/** Physical table names — identical to the Serverless stack (PIVOTE: same names). */
export function tableNames(environment: EnvironmentName) {
  const p = `mkpdfs-${environment}`;
  return {
    users: `${p}-users`,
    tokens: `${p}-tokens`,
    usage: `${p}-usage`,
    subscriptions: `${p}-subscriptions`,
    templates: `${p}-templates`,
    marketplace: `${p}-marketplace`,
    jobs: `${p}-jobs`,
    rateLimits: `${p}-rate-limits`,
    aiJobs: `${p}-ai-jobs`,
    cliAuth: `${p}-cli-auth`,
    creditLedger: `${p}-credit-ledger`,
  };
}

export function bucketName(environment: EnvironmentName): string {
  return `mkpdfs-${environment}-bucket`;
}

export function queueNames(environment: EnvironmentName) {
  const p = `mkpdfs-${environment}`;
  return {
    pdfGeneration: `${p}-pdf-generation`,
    pdfGenerationDlq: `${p}-pdf-generation-dlq`,
    aiGeneration: `${p}-ai-generation`,
    aiGenerationDlq: `${p}-ai-generation-dlq`,
  };
}

/** SSM parameter names (runtime-resolved by the lambdas; see src/libs/ssmParams.ts). */
export function ssmParamNames(environment: EnvironmentName) {
  const p = `/mkpdfs/${environment}`;
  return {
    stripeSecretKey: `${p}/stripe-secret-key`,
    stripeWebhookSecret: `${p}/stripe-webhook-secret`,
    stripePriceCredits1000: `${p}/stripe-price-credits-1000`,
  };
}
