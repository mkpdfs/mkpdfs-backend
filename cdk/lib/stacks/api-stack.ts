import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import {
  CHROMIUM_LAYER_ARN,
  EnvConfig,
  HOSTED_ZONE_ID,
  HOSTED_ZONE_NAME,
} from '../config';
import {
  buildCommonEnv,
  createServiceFunction,
  grantBedrock,
  grantSes,
  grantSsmParams,
  ServiceFunctionProps,
} from '../service-function';
import { MkpdfsTables } from './database-stack';

export interface ApiStackProps extends cdk.StackProps {
  cfg: EnvConfig;
  tables: MkpdfsTables;
  bucket: s3.Bucket;
  pdfGenerationQueue: sqs.Queue;
  aiGenerationQueue: sqs.Queue;
  userPool: cognito.UserPool;
  userPoolClientId: string;
  identityPoolId: string;
}

/**
 * REST API (REGIONAL) + the 28 HTTP lambdas, exact mirror of the inventory
 * table (routes/auth/timeouts/memory/layers). CORS:
 * - Real preflight via defaultCorsPreflightOptions (enmienda 1) with the same
 *   headers the serverless plugin generated (incl. x-api-key).
 * - GatewayResponses with CORS headers for error paths (4XX/5XX/ACCESS_DENIED/
 *   UNAUTHORIZED/EXPIRED_TOKEN), parity with src/resources/apigateway.ts.
 *
 * Custom domain (PIVOTE item 3): DomainName EDGE + root BasePathMapping +
 * Route53 A/AAAA, all CDK-managed. The legacy plugin-created domain/records
 * are deleted by the orchestrator's runbook BEFORE this deploys.
 */
export class ApiStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;
  /** Billing-critical lambdas exposed for the Monitoring stack. */
  public readonly stripeWebhookFn: lambdaNode.NodejsFunction;
  public readonly generatePdfFn: lambdaNode.NodejsFunction;
  public readonly generatePdfApiKeyFn: lambdaNode.NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const {
      cfg,
      tables,
      bucket,
      pdfGenerationQueue,
      aiGenerationQueue,
      userPool,
      userPoolClientId,
      identityPoolId,
    } = props;
    const env = cfg.environment;

    // -----------------------------------------------------------------
    // REST API
    // -----------------------------------------------------------------
    const corsHeaders =
      "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent'";
    const corsMethods = "'OPTIONS,GET,POST,PUT,DELETE,PATCH'";

    this.api = new apigateway.RestApi(this, 'Api', {
      restApiName: `mkpdfs-api-${env}`,
      description: `mkpdfs API (${env}) — CDK`,
      endpointConfiguration: { types: [apigateway.EndpointType.REGIONAL] },
      deployOptions: { stageName: env }, // must match the base path mapping stage
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
          'X-Amz-Security-Token',
          'X-Amz-User-Agent',
        ],
        allowMethods: ['OPTIONS', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
      },
      // Custom domain is created explicitly below (Route53 records need it)
    });

    // Gateway responses: CORS on error paths (parity with the legacy template)
    const responseTypes: Array<[string, apigateway.ResponseType]> = [
      ['Default4XX', apigateway.ResponseType.DEFAULT_4XX],
      ['Default5XX', apigateway.ResponseType.DEFAULT_5XX],
      ['AccessDenied', apigateway.ResponseType.ACCESS_DENIED],
      ['Unauthorized', apigateway.ResponseType.UNAUTHORIZED],
      ['ExpiredToken', apigateway.ResponseType.EXPIRED_TOKEN],
    ];
    for (const [name, type] of responseTypes) {
      this.api.addGatewayResponse(`GatewayResponse${name}`, {
        type,
        responseHeaders: {
          'Access-Control-Allow-Origin': "'*'",
          'Access-Control-Allow-Headers': corsHeaders,
          'Access-Control-Allow-Methods': corsMethods,
        },
      });
    }

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'Authorizer', {
      authorizerName: 'CognitoAuthorizer',
      cognitoUserPools: [userPool],
      identitySource: 'method.request.header.Authorization',
    });

    // -----------------------------------------------------------------
    // Shared bits
    // -----------------------------------------------------------------
    const chromiumLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      'ChromiumLayer',
      CHROMIUM_LAYER_ARN,
    );

    const commonEnv = buildCommonEnv(this, {
      cfg,
      queueUrls: {
        pdfGeneration: pdfGenerationQueue.queueUrl,
        aiGeneration: aiGenerationQueue.queueUrl,
      },
      cognito: { userPoolId: userPool.userPoolId, userPoolClientId, identityPoolId },
    });

    const makeFn = (
      fnId: string,
      fnProps: Omit<ServiceFunctionProps, 'environment'>,
    ): lambdaNode.NodejsFunction =>
      createServiceFunction(this, fnId, { ...fnProps, environment: commonEnv });

    const addRoute = (
      routePath: string,
      method: string,
      fn: lambda.IFunction,
      cognitoAuth: boolean,
    ): void => {
      const resource = this.api.root.resourceForPath(routePath);
      resource.addMethod(
        method,
        new apigateway.LambdaIntegration(fn),
        cognitoAuth
          ? {
              authorizer,
              authorizationType: apigateway.AuthorizationType.COGNITO,
            }
          : undefined,
      );
    };

    // Middleware-derived grant bundles (see src/libs/middleware/*):
    // dualAuth/apiKeyOnly validate tlfy_ tokens → tokens RW (lastUsed update)
    const grantDualAuth = (fn: lambda.Function) =>
      tables.tokens.grantReadWriteData(fn);
    // subscriptionMiddleware: subscriptions get+create, usage get
    const grantSubscriptionMw = (fn: lambda.Function) => {
      tables.subscriptions.grantReadWriteData(fn);
      tables.usage.grantReadData(fn);
    };
    // usageTrackingMiddleware: usage counters update
    const grantUsageTracking = (fn: lambda.Function) =>
      tables.usage.grantReadWriteData(fn);

    // =================================================================
    // USER (Cognito auth)
    // =================================================================
    const getUserProfile = makeFn('GetUserProfileFn', {
      entry: 'src/functions/user/getProfile/handler.ts',
    });
    tables.users.grantReadWriteData(getUserProfile); // creates profile on first read
    grantSubscriptionMw(getUserProfile);
    addRoute('/user/profile', 'GET', getUserProfile, true);

    const updateUserProfile = makeFn('UpdateUserProfileFn', {
      entry: 'src/functions/user/updateProfile/handler.ts',
    });
    // handler is a stub ("Not implemented yet") — no data grants
    addRoute('/user/profile', 'PUT', updateUserProfile, true);

    const listUserTokens = makeFn('ListUserTokensFn', {
      entry: 'src/functions/user/listTokens/handler.ts',
    });
    tables.tokens.grantReadData(listUserTokens);
    addRoute('/user/tokens', 'GET', listUserTokens, true);

    const createUserToken = makeFn('CreateUserTokenFn', {
      entry: 'src/functions/user/createToken/handler.ts',
    });
    tables.tokens.grantReadWriteData(createUserToken);
    grantSubscriptionMw(createUserToken);
    grantUsageTracking(createUserToken);
    addRoute('/user/tokens', 'POST', createUserToken, true);

    const deleteUserToken = makeFn('DeleteUserTokenFn', {
      entry: 'src/functions/user/deleteToken/handler.ts',
    });
    tables.tokens.grantReadWriteData(deleteUserToken);
    addRoute('/user/tokens/{tokenId}', 'DELETE', deleteUserToken, true);

    const getUserUsage = makeFn('GetUserUsageFn', {
      entry: 'src/functions/user/getUsage/handler.ts',
    });
    tables.usage.grantReadData(getUserUsage);
    tables.templates.grantReadData(getUserUsage);
    tables.tokens.grantReadData(getUserUsage);
    addRoute('/user/usage', 'GET', getUserUsage, true);

    // =================================================================
    // TEMPLATES (Cognito auth)
    // =================================================================
    const listUserTemplates = makeFn('ListUserTemplatesFn', {
      entry: 'src/functions/templates/listTemplates/handler.ts',
    });
    tables.templates.grantReadData(listUserTemplates);
    tables.marketplace.grantReadData(listUserTemplates); // BatchGet for marketplace-sourced templates
    bucket.grantRead(listUserTemplates); // presigned thumbnail URLs
    addRoute('/templates', 'GET', listUserTemplates, true);

    const getUserTemplate = makeFn('GetUserTemplateFn', {
      entry: 'src/functions/templates/getTemplate/handler.ts',
    });
    tables.templates.grantReadData(getUserTemplate);
    bucket.grantRead(getUserTemplate);
    addRoute('/templates/{templateId}', 'GET', getUserTemplate, true);

    const uploadTemplate = makeFn('UploadTemplateFn', {
      entry: 'src/functions/templates/uploadTemplate/handler.ts',
    });
    tables.templates.grantReadWriteData(uploadTemplate);
    bucket.grantPut(uploadTemplate);
    grantSubscriptionMw(uploadTemplate);
    grantUsageTracking(uploadTemplate);
    addRoute('/templates/upload', 'POST', uploadTemplate, true);

    const updateTemplate = makeFn('UpdateTemplateFn', {
      entry: 'src/functions/templates/updateTemplate/handler.ts',
    });
    tables.templates.grantReadWriteData(updateTemplate);
    bucket.grantPut(updateTemplate);
    grantSubscriptionMw(updateTemplate);
    addRoute('/templates/{templateId}', 'PUT', updateTemplate, true);

    const logoUploadUrl = makeFn('LogoUploadUrlFn', {
      entry: 'src/functions/templates/logoUploadUrl/handler.ts',
      timeoutSeconds: 10,
      memorySize: 256,
    });
    bucket.grantPut(logoUploadUrl); // presigned PUT for the logo file
    grantSubscriptionMw(logoUploadUrl);
    addRoute('/templates/logo-upload-url', 'POST', logoUploadUrl, true);

    const updateTemplateTheme = makeFn('UpdateTemplateThemeFn', {
      entry: 'src/functions/templates/updateTheme/handler.ts',
    });
    tables.templates.grantReadWriteData(updateTemplateTheme);
    bucket.grantPut(updateTemplateTheme); // store URL-ingested logos
    grantSubscriptionMw(updateTemplateTheme);
    addRoute('/templates/{templateId}/theme', 'PATCH', updateTemplateTheme, true);

    const deleteTemplate = makeFn('DeleteTemplateFn', {
      entry: 'src/functions/templates/deleteTemplate/handler.ts',
    });
    tables.templates.grantReadWriteData(deleteTemplate);
    bucket.grantDelete(deleteTemplate);
    addRoute('/templates/{templateId}', 'DELETE', deleteTemplate, true);

    // =================================================================
    // TEMPLATES v1 — server-to-server (x-api-key, NO gateway authorizer)
    // Reuse the JWT handler cores; each fn = JWT sibling's grants + grantDualAuth
    // (apiKeyOnlyMiddleware reads/updates TOKENS_TABLE before the handler runs).
    // =================================================================
    const listTemplatesApiKey = makeFn('ListTemplatesApiKeyFn', {
      entry: 'src/functions/templates/listTemplatesApiKey/handler.ts',
    });
    grantDualAuth(listTemplatesApiKey);
    tables.templates.grantReadData(listTemplatesApiKey);
    tables.marketplace.grantReadData(listTemplatesApiKey);
    bucket.grantRead(listTemplatesApiKey);
    addRoute('/v1/templates', 'GET', listTemplatesApiKey, false);

    const getTemplateApiKey = makeFn('GetTemplateApiKeyFn', {
      entry: 'src/functions/templates/getTemplateApiKey/handler.ts',
    });
    grantDualAuth(getTemplateApiKey);
    tables.templates.grantReadData(getTemplateApiKey);
    bucket.grantRead(getTemplateApiKey);
    addRoute('/v1/templates/{templateId}', 'GET', getTemplateApiKey, false);

    const uploadTemplateApiKey = makeFn('UploadTemplateApiKeyFn', {
      entry: 'src/functions/templates/uploadTemplateApiKey/handler.ts',
    });
    grantDualAuth(uploadTemplateApiKey);
    tables.templates.grantReadWriteData(uploadTemplateApiKey);
    bucket.grantPut(uploadTemplateApiKey);
    grantSubscriptionMw(uploadTemplateApiKey);
    grantUsageTracking(uploadTemplateApiKey);
    addRoute('/v1/templates/upload', 'POST', uploadTemplateApiKey, false);

    const updateTemplateApiKey = makeFn('UpdateTemplateApiKeyFn', {
      entry: 'src/functions/templates/updateTemplateApiKey/handler.ts',
    });
    grantDualAuth(updateTemplateApiKey);
    tables.templates.grantReadWriteData(updateTemplateApiKey);
    bucket.grantPut(updateTemplateApiKey);
    grantSubscriptionMw(updateTemplateApiKey);
    addRoute('/v1/templates/{templateId}', 'PUT', updateTemplateApiKey, false);

    const deleteTemplateApiKey = makeFn('DeleteTemplateApiKeyFn', {
      entry: 'src/functions/templates/deleteTemplateApiKey/handler.ts',
    });
    grantDualAuth(deleteTemplateApiKey);
    tables.templates.grantReadWriteData(deleteTemplateApiKey);
    bucket.grantDelete(deleteTemplateApiKey);
    addRoute('/v1/templates/{templateId}', 'DELETE', deleteTemplateApiKey, false);

    // =================================================================
    // PDF (layer chromium; dual auth in-lambda)
    // =================================================================
    const generatePdfAsync = makeFn('GeneratePdfAsyncFn', {
      entry: 'src/functions/pdf/generateAsync/handler.ts',
      timeoutSeconds: 60,
      memorySize: 2048,
      layers: [chromiumLayer],
      description: 'Deprecated async path (stub) — kept for parity',
    });
    grantDualAuth(generatePdfAsync);
    addRoute('/pdf/generate-async', 'POST', generatePdfAsync, true);

    const generatePdf = makeFn('GeneratePdfFn', {
      entry: 'src/functions/pdf/generate/handler.ts',
      timeoutSeconds: 30,
      memorySize: 4096, // Chromium render is CPU-bound; CPU scales with memory
      layers: [chromiumLayer],
    });
    grantDualAuth(generatePdf);
    grantSubscriptionMw(generatePdf);
    grantUsageTracking(generatePdf);
    bucket.grantRead(generatePdf); // template read + presigned GET
    bucket.grantPut(generatePdf); // generated PDF
    tables.templates.grantReadData(generatePdf); // pdfService reads the theme + contentVersion
    grantSes(generatePdf); // sendEmail option
    tables.creditLedger.grantWriteData(generatePdf); // debit ledger entries
    grantSsmParams(generatePdf, env); // stripe-secret-key for auto-recharge
    // Enmienda 3: self-invoke by env-injected name, not the legacy hardcoded one
    generatePdf.addEnvironment(
      'GENERATE_PDF_ASYNC_FUNCTION_NAME',
      generatePdfAsync.functionName,
    );
    generatePdfAsync.grantInvoke(generatePdf);
    addRoute('/pdf/generate', 'POST', generatePdf, true);

    // Server-to-server: NO gateway authorizer (auth in-lambda, x-api-key tlfy_*)
    const generatePdfApiKey = makeFn('GeneratePdfApiKeyFn', {
      entry: 'src/functions/pdf/generateApiKey/handler.ts',
      timeoutSeconds: 30,
      memorySize: 4096, // Chromium render is CPU-bound; CPU scales with memory
      layers: [chromiumLayer],
    });
    grantDualAuth(generatePdfApiKey);
    grantSubscriptionMw(generatePdfApiKey);
    grantUsageTracking(generatePdfApiKey);
    bucket.grantRead(generatePdfApiKey);
    bucket.grantPut(generatePdfApiKey);
    tables.templates.grantReadData(generatePdfApiKey);
    grantSes(generatePdfApiKey);
    tables.creditLedger.grantWriteData(generatePdfApiKey); // debit ledger entries
    grantSsmParams(generatePdfApiKey, env); // stripe-secret-key for auto-recharge
    generatePdfApiKey.addEnvironment(
      'GENERATE_PDF_ASYNC_FUNCTION_NAME',
      generatePdfAsync.functionName,
    );
    generatePdfAsync.grantInvoke(generatePdfApiKey);
    addRoute('/v1/pdf/generate', 'POST', generatePdfApiKey, false);

    // =================================================================
    // MCP (API-key only) — thin adapter over the /v1/* routes above.
    // Can execute generatePdfApiKey's full render path plus all 5 template
    // *ApiKey handlers in-process (see src/functions/mcp/tools.ts), so it
    // needs their combined footprint: Chromium layer + the union of grants.
    // =================================================================
    const mcpFn = makeFn('McpFn', {
      entry: 'src/functions/mcp/handler.ts',
      timeoutSeconds: 30,
      memorySize: 4096,
      layers: [chromiumLayer],
    });
    grantDualAuth(mcpFn);
    grantSubscriptionMw(mcpFn);
    grantUsageTracking(mcpFn);
    bucket.grantRead(mcpFn);
    bucket.grantPut(mcpFn);
    bucket.grantDelete(mcpFn);
    tables.templates.grantReadWriteData(mcpFn);
    tables.marketplace.grantReadData(mcpFn);
    grantSes(mcpFn);
    tables.creditLedger.grantWriteData(mcpFn); // debit ledger entries (generate_pdf)
    grantSsmParams(mcpFn, env); // stripe-secret-key for auto-recharge
    mcpFn.addEnvironment(
      'GENERATE_PDF_ASYNC_FUNCTION_NAME',
      generatePdfAsync.functionName,
    );
    generatePdfAsync.grantInvoke(mcpFn);
    addRoute('/v1/mcp', 'POST', mcpFn, false);

    // =================================================================
    // JOBS (async PDF generation)
    // =================================================================
    const submitJob = makeFn('SubmitJobFn', {
      entry: 'src/functions/jobs/submit/handler.ts',
      timeoutSeconds: 30,
      memorySize: 256,
    });
    grantDualAuth(submitJob);
    grantSubscriptionMw(submitJob);
    tables.jobs.grantWriteData(submitJob);
    pdfGenerationQueue.grantSendMessages(submitJob);
    addRoute('/jobs/submit', 'POST', submitJob, true);

    const getJobStatus = makeFn('GetJobStatusFn', {
      entry: 'src/functions/jobs/getStatus/handler.ts',
      timeoutSeconds: 10,
      memorySize: 256,
    });
    grantDualAuth(getJobStatus);
    tables.jobs.grantReadData(getJobStatus);
    addRoute('/jobs/{jobId}', 'GET', getJobStatus, true);

    // =================================================================
    // STRIPE
    // =================================================================
    const stripeCreateCheckoutSession = makeFn('StripeCreateCheckoutSessionFn', {
      entry: 'src/functions/stripe/createCheckoutSession/handler.ts',
    });
    tables.users.grantReadData(stripeCreateCheckoutSession);
    tables.subscriptions.grantReadWriteData(stripeCreateCheckoutSession);
    grantSsmParams(stripeCreateCheckoutSession, env); // stripe-secret-key at runtime
    addRoute('/stripe/create-checkout-session', 'POST', stripeCreateCheckoutSession, true);

    const stripeCreatePortalSession = makeFn('StripeCreatePortalSessionFn', {
      entry: 'src/functions/stripe/createPortalSession/handler.ts',
    });
    tables.subscriptions.grantReadData(stripeCreatePortalSession);
    grantSsmParams(stripeCreatePortalSession, env);
    addRoute('/stripe/create-portal-session', 'POST', stripeCreatePortalSession, true);

    // No authorizer — Stripe verifies via signature
    const stripeWebhook = makeFn('StripeWebhookFn', {
      entry: 'src/functions/stripe/webhook/handler.ts',
    });
    tables.subscriptions.grantReadWriteData(stripeWebhook);
    tables.creditLedger.grantWriteData(stripeWebhook); // idempotent credit txn
    grantSsmParams(stripeWebhook, env); // secret-key + webhook-secret at runtime
    addRoute('/stripe/webhook', 'POST', stripeWebhook, false);

    // Exposed for the Monitoring stack (billing-critical alarms)
    this.stripeWebhookFn = stripeWebhook;
    this.generatePdfFn = generatePdf;
    this.generatePdfApiKeyFn = generatePdfApiKey;

    // =================================================================
    // BILLING (credits)
    // =================================================================
    const billingUpdateAutoRecharge = makeFn('BillingUpdateAutoRechargeFn', {
      entry: 'src/functions/billing/updateAutoRecharge/handler.ts',
    });
    tables.subscriptions.grantReadWriteData(billingUpdateAutoRecharge);
    addRoute('/billing/auto-recharge', 'PUT', billingUpdateAutoRecharge, true);

    const billingGetLedger = makeFn('BillingGetLedgerFn', {
      entry: 'src/functions/billing/getLedger/handler.ts',
    });
    tables.creditLedger.grantReadData(billingGetLedger);
    addRoute('/billing/ledger', 'GET', billingGetLedger, true);

    // =================================================================
    // MARKETPLACE (public browse, authenticated use)
    // =================================================================
    const marketplaceListTemplates = makeFn('MarketplaceListTemplatesFn', {
      entry: 'src/functions/marketplace/listTemplates/handler.ts',
    });
    tables.marketplace.grantReadData(marketplaceListTemplates);
    addRoute('/marketplace/templates', 'GET', marketplaceListTemplates, false);

    const marketplaceGetTemplate = makeFn('MarketplaceGetTemplateFn', {
      entry: 'src/functions/marketplace/getTemplate/handler.ts',
    });
    tables.marketplace.grantReadData(marketplaceGetTemplate);
    addRoute('/marketplace/templates/{templateId}', 'GET', marketplaceGetTemplate, false);

    const marketplaceGetTemplatePreview = makeFn('MarketplaceGetTemplatePreviewFn', {
      entry: 'src/functions/marketplace/getTemplatePreview/handler.ts',
    });
    tables.marketplace.grantReadData(marketplaceGetTemplatePreview);
    bucket.grantRead(marketplaceGetTemplatePreview);
    addRoute(
      '/marketplace/templates/{templateId}/preview',
      'GET',
      marketplaceGetTemplatePreview,
      false,
    );

    const marketplaceUseTemplate = makeFn('MarketplaceUseTemplateFn', {
      entry: 'src/functions/marketplace/useTemplate/handler.ts',
    });
    tables.marketplace.grantReadWriteData(marketplaceUseTemplate); // usage counter
    tables.templates.grantReadWriteData(marketplaceUseTemplate);
    bucket.grantRead(marketplaceUseTemplate); // CopyObject source
    bucket.grantPut(marketplaceUseTemplate); // CopyObject destination
    grantSubscriptionMw(marketplaceUseTemplate);
    addRoute('/marketplace/templates/{templateId}/use', 'POST', marketplaceUseTemplate, true);

    // =================================================================
    // AI (premium)
    // =================================================================
    const generateAITemplate = makeFn('GenerateAITemplateFn', {
      entry: 'src/functions/ai/generateTemplate/handler.ts',
      timeoutSeconds: 60,
      memorySize: 1024,
    });
    grantBedrock(generateAITemplate);
    grantSubscriptionMw(generateAITemplate);
    grantUsageTracking(generateAITemplate);
    addRoute('/ai/generate-template', 'POST', generateAITemplate, true);

    const submitAIGeneration = makeFn('SubmitAIGenerationFn', {
      entry: 'src/functions/ai/submitGeneration/handler.ts',
      timeoutSeconds: 30,
      memorySize: 256,
    });
    tables.aiJobs.grantWriteData(submitAIGeneration);
    aiGenerationQueue.grantSendMessages(submitAIGeneration);
    grantSubscriptionMw(submitAIGeneration);
    addRoute('/ai/generate-template-async', 'POST', submitAIGeneration, true);

    const getAIJobStatus = makeFn('GetAIJobStatusFn', {
      entry: 'src/functions/ai/getStatus/handler.ts',
      timeoutSeconds: 10,
      memorySize: 256,
    });
    tables.aiJobs.grantReadData(getAIJobStatus);
    addRoute('/ai/jobs/{jobId}', 'GET', getAIJobStatus, true);

    const getAIImageUploadUrl = makeFn('GetAIImageUploadUrlFn', {
      entry: 'src/functions/ai/getImageUploadUrl/handler.ts',
      timeoutSeconds: 10,
      memorySize: 256,
    });
    bucket.grantPut(getAIImageUploadUrl); // presigned PUT for reference images
    grantSubscriptionMw(getAIImageUploadUrl);
    addRoute('/ai/image-upload-url', 'POST', getAIImageUploadUrl, true);

    // =================================================================
    // CONTACT (public, rate-limited by IP in DDB)
    // =================================================================
    const contactEnterprise = makeFn('ContactEnterpriseFn', {
      entry: 'src/functions/contact/enterpriseContact/handler.ts',
    });
    tables.rateLimits.grantReadWriteData(contactEnterprise);
    grantSsmParams(contactEnterprise, env); // twilio-* + enterprise-contact-phone
    addRoute('/contact/enterprise', 'POST', contactEnterprise, false);

    // ---- CLI device-flow auth ----
    const cliDevice = makeFn('CliDeviceFn', {
      entry: 'src/functions/auth/cli/device/handler.ts',
      description: 'CLI device flow: start (public, IP rate-limited)',
    });
    tables.cliAuth.grantWriteData(cliDevice);
    tables.rateLimits.grantReadWriteData(cliDevice);
    addRoute('/auth/cli/device', 'POST', cliDevice, false);

    const cliApprove = makeFn('CliApproveFn', {
      entry: 'src/functions/auth/cli/approve/handler.ts',
      description: 'CLI device flow: approve/deny (Cognito JWT)',
    });
    tables.cliAuth.grantReadWriteData(cliApprove);
    tables.rateLimits.grantReadWriteData(cliApprove);
    addRoute('/auth/cli/approve', 'POST', cliApprove, true);

    const cliToken = makeFn('CliTokenFn', {
      entry: 'src/functions/auth/cli/token/handler.ts',
      description: 'CLI device flow: token polling (public, interval-enforced)',
    });
    tables.cliAuth.grantReadWriteData(cliToken);
    addRoute('/auth/cli/token', 'POST', cliToken, false);

    // =================================================================
    // Custom domain (EDGE, same TLS policy) + Route53 A/AAAA
    // =================================================================
    const domain = new apigateway.DomainName(this, 'CustomDomain', {
      domainName: cfg.apiDomainName,
      certificate: certificatemanager.Certificate.fromCertificateArn(
        this,
        'ApiCertificate',
        cfg.certificateArn,
      ),
      endpointType: apigateway.EndpointType.EDGE,
      securityPolicy: apigateway.SecurityPolicy.TLS_1_2,
    });

    new apigateway.BasePathMapping(this, 'BasePathMapping', {
      domainName: domain,
      restApi: this.api,
      stage: this.api.deploymentStage, // root base path ('')
    });

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: HOSTED_ZONE_NAME,
    });
    const aliasTarget = route53.RecordTarget.fromAlias(
      new route53targets.ApiGatewayDomain(domain),
    );
    new route53.ARecord(this, 'ApiAliasRecord', {
      zone,
      recordName: cfg.apiDomainName,
      target: aliasTarget,
    });
    new route53.AaaaRecord(this, 'ApiAliasRecordAAAA', {
      zone,
      recordName: cfg.apiDomainName,
      target: aliasTarget,
    });

    // =================================================================
    // Outputs
    // =================================================================
    // Deploy-time SSM refs (stripe-price-credits-1000) only re-resolve when
    // CFN sees a template change — bump this value after editing the param
    // so the next CI deploy picks the new price id.
    new cdk.CfnOutput(this, 'StripePriceParamGeneration', {
      value: 'credits-1000-gen2',
      description: 'Bump to force re-resolution of deploy-time Stripe SSM params',
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'execute-api URL (direct, bypasses the custom domain)',
    });
    new cdk.CfnOutput(this, 'ApiId', {
      value: this.api.restApiId,
      description: 'RestApi ID',
    });
    new cdk.CfnOutput(this, 'CustomDomainUrl', {
      value: `https://${cfg.apiDomainName}`,
      description: 'Public API URL (custom domain)',
    });
    new cdk.CfnOutput(this, 'CustomDomainCloudFrontTarget', {
      value: domain.domainNameAliasDomainName,
      description: 'CloudFront distribution backing the edge custom domain',
    });
  }
}
