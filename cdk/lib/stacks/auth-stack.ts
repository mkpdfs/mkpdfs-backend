import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { EnvConfig, REGION } from '../config';
import { buildCommonEnv, createServiceFunction } from '../service-function';

export interface AuthStackProps extends cdk.StackProps {
  cfg: EnvConfig;
  usersTable: dynamodb.Table;
}

/**
 * Cognito OWNED by CDK (PIVOTE): a NEW UserPool/Client/IdentityPool/Hosted UI
 * domain with the SAME configuration as the legacy active pool
 * (src/resources/cognito.ts): email username, MFA OPTIONAL (TOTP), advanced
 * security ENFORCED, password 8+all, Google IdP from SecretsManager
 * mkpdfs/google-oauth/{env}, hosted UI prefix auth-mkpdfs-{env}.
 *
 * Fixes baked in:
 * - preSignUp/postConfirmation triggers are attached DIRECTLY to this pool
 *   (kills the legacy phantom-pool bug at the root; no merge-safe
 *   CustomResource needed anymore).
 * - dev callbacks/logout URLs include dev.mkpdfs.com (missing in the legacy
 *   dev pool).
 *
 * The pool IDs CHANGE (accepted by the owner — no real users). mkpdfs-web
 * must be re-pointed using this stack's outputs.
 */
export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly identityPoolId: string;
  public readonly preSignUpFn: lambdaNode.NodejsFunction;
  public readonly postConfirmationFn: lambdaNode.NodejsFunction;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const { cfg, usersTable } = props;
    const removalPolicy = cfg.isProd
      ? cdk.RemovalPolicy.RETAIN
      : cdk.RemovalPolicy.DESTROY;

    // -----------------------------------------------------------------
    // Cognito trigger lambdas (6s/1024MB defaults, same as Serverless).
    // Their env omits USER_POOL_ID/CLIENT/IDENTITY (the pool referencing a
    // lambda whose env references the pool back would be a CFN cycle) and
    // the queue URLs (unused; keeps Auth independent from the Jobs stack).
    // The handlers only read USERS_TABLE.
    // -----------------------------------------------------------------
    const triggerEnv = buildCommonEnv(this, { cfg });

    this.preSignUpFn = createServiceFunction(this, 'PreSignUpFn', {
      entry: 'src/functions/cognito/preSignUp/handler.ts',
      environment: triggerEnv,
      description: 'Cognito PreSignUp trigger (auto-confirm logic)',
    });

    this.postConfirmationFn = createServiceFunction(this, 'PostConfirmationFn', {
      entry: 'src/functions/cognito/postConfirmation/handler.ts',
      environment: triggerEnv,
      description: 'Cognito PostConfirmation trigger (creates the users-table row)',
    });
    usersTable.grantReadWriteData(this.postConfirmationFn);

    // -----------------------------------------------------------------
    // User pool — config mirror of the legacy ACTIVE pool
    // -----------------------------------------------------------------
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `mkpdfs-${cfg.environment}-user-pool`,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      advancedSecurityMode: cognito.AdvancedSecurityMode.ENFORCED,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      lambdaTriggers: {
        preSignUp: this.preSignUpFn,
        postConfirmation: this.postConfirmationFn,
      },
      removalPolicy,
    });

    // Hosted UI domain (required for OAuth flows) — same prefix as legacy.
    // RETAIN in prod: the prefix is baked into OAuth redirects.
    const hostedUiDomain = this.userPool.addDomain('HostedUiDomain', {
      cognitoDomain: { domainPrefix: cfg.hostedUiDomainPrefix },
    });
    hostedUiDomain.applyRemovalPolicy(removalPolicy);

    // Google IdP — secrets stay in SecretsManager mkpdfs/google-oauth/{env}
    // (resolved via CFN dynamic references, exactly like the legacy template)
    const googleSecretId = `mkpdfs/google-oauth/${cfg.environment}`;
    const googleIdp = new cognito.UserPoolIdentityProviderGoogle(this, 'GoogleIdp', {
      userPool: this.userPool,
      clientId: cdk.SecretValue.secretsManager(googleSecretId, {
        jsonField: 'client_id',
      }).unsafeUnwrap(), // renders the {{resolve:secretsmanager:...}} dynamic ref
      clientSecretValue: cdk.SecretValue.secretsManager(googleSecretId, {
        jsonField: 'client_secret',
      }),
      scopes: ['openid', 'email', 'profile'],
      attributeMapping: {
        email: cognito.ProviderAttribute.GOOGLE_EMAIL,
        fullname: cognito.ProviderAttribute.GOOGLE_NAME,
        profilePicture: cognito.ProviderAttribute.GOOGLE_PICTURE,
        givenName: cognito.ProviderAttribute.GOOGLE_GIVEN_NAME,
        familyName: cognito.ProviderAttribute.GOOGLE_FAMILY_NAME,
      },
    });

    // Web client — same flows/scopes/validities as legacy + dev callbacks fix
    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: `mkpdfs-${cfg.environment}-web-client`,
      generateSecret: false,
      authFlows: { userPassword: true, userSrp: true },
      preventUserExistenceErrors: true,
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
        cognito.UserPoolClientIdentityProvider.GOOGLE,
      ],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
          cognito.OAuthScope.COGNITO_ADMIN,
        ],
        callbackUrls: cfg.callbackUrls,
        logoutUrls: cfg.logoutUrls,
      },
      refreshTokenValidity: cdk.Duration.days(30),
      accessTokenValidity: cdk.Duration.minutes(60),
      idTokenValidity: cdk.Duration.minutes(60),
    });
    // The client lists Google as a provider — make sure the IdP exists first
    this.userPoolClient.node.addDependency(googleIdp);
    // RETAIN in prod: the client ID is baked into mkpdfs-web / Academia Connects
    this.userPoolClient.applyRemovalPolicy(removalPolicy);

    // -----------------------------------------------------------------
    // Identity pool + authenticated role (execute-api:Invoke), as legacy
    // -----------------------------------------------------------------
    const identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      identityPoolName: `mkpdfs_${cfg.environment}_identity_pool`,
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: this.userPoolClient.userPoolClientId,
          providerName: this.userPool.userPoolProviderName,
        },
      ],
    });
    // RETAIN in prod: the identity pool ID is baked into the frontends
    identityPool.applyRemovalPolicy(removalPolicy);
    this.identityPoolId = identityPool.ref;

    const authRole = new iam.Role(this, 'CognitoAuthRole', {
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: {
            'cognito-identity.amazonaws.com:aud': identityPool.ref,
          },
          'ForAnyValue:StringLike': {
            'cognito-identity.amazonaws.com:amr': 'authenticated',
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
    });
    authRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'mobileanalytics:PutEvents',
          'cognito-sync:*',
          'cognito-identity:*',
        ],
        resources: ['*'],
      }),
    );
    authRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['execute-api:Invoke'],
        resources: [`arn:aws:execute-api:${REGION}:${this.account}:*/*`],
      }),
    );

    const identityPoolRoles = new cognito.CfnIdentityPoolRoleAttachment(
      this,
      'IdentityPoolRoles',
      {
        identityPoolId: identityPool.ref,
        roles: { authenticated: authRole.roleArn },
      },
    );
    identityPoolRoles.applyRemovalPolicy(removalPolicy);

    // -----------------------------------------------------------------
    // Outputs (frontend + provisioning consume these)
    // -----------------------------------------------------------------
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Cognito User Pool ID (NEW — re-point mkpdfs-web)',
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool web client ID',
    });
    new cdk.CfnOutput(this, 'IdentityPoolId', {
      value: identityPool.ref,
      description: 'Cognito Identity Pool ID',
    });
    new cdk.CfnOutput(this, 'HostedUiDomain', {
      value: hostedUiDomain.domainName,
      description: 'Cognito Hosted UI domain prefix',
    });
    new cdk.CfnOutput(this, 'HostedUiUrl', {
      value: `https://${cfg.hostedUiDomainPrefix}.auth.${REGION}.amazoncognito.com`,
      description: 'Cognito Hosted UI base URL',
    });
  }
}
