import type { AWS } from '@serverless/typescript';

import * as functions from '@functions/index';
import { dynamoDbTables } from '@resources/dynamodb';
import { s3Buckets } from '@resources/s3';
import { cognitoResources } from '@resources/cognito';
import { cloudFrontDistribution } from '@resources/cloudfront';

const serverlessConfiguration: AWS = {
  service: 'templify-api',
  frameworkVersion: '3',
  plugins: [
    'serverless-esbuild',
    'serverless-offline'
  ],
  provider: {
    name: 'aws',
    runtime: 'nodejs20.x',
    stage: '${opt:stage, "dev"}',
    region: 'us-east-1',
    // Profile removed - use AWS_PROFILE env var for local dev, OIDC for CI/CD
    environment: {
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      NODE_OPTIONS: '--enable-source-maps --stack-trace-limit=1000',
      STAGE: '${self:provider.stage}',
      REGION: '${self:provider.region}',
      SERVICE_NAME: '${self:service}',
      
      // DynamoDB tables
      USERS_TABLE: 'templify-${self:provider.stage}-users',
      TOKENS_TABLE: 'templify-${self:provider.stage}-tokens',
      USAGE_TABLE: 'templify-${self:provider.stage}-usage',
      SUBSCRIPTIONS_TABLE: 'templify-${self:provider.stage}-subscriptions',
      TEMPLATES_TABLE: 'templify-${self:provider.stage}-templates',
      
      // S3 buckets
      ASSETS_BUCKET: 'templify-${self:provider.stage}-assets',
      
      // Cognito
      USER_POOL_ID: { Ref: 'CognitoUserPool' },
      USER_POOL_CLIENT_ID: { Ref: 'CognitoUserPoolClient' },
      IDENTITY_POOL_ID: { Ref: 'CognitoIdentityPool' },
      
      // Email settings
      FROM_EMAIL: 'noreply@templifying.com',
      
      // Offline settings
      IS_OFFLINE: '${env:IS_OFFLINE, "false"}',
      CHROMIUM_PATH: '${env:CHROMIUM_PATH, ""}',
    },
    iam: {
      role: {
        statements: [
          {
            Effect: 'Allow',
            Action: [
              'dynamodb:Query',
              'dynamodb:Scan',
              'dynamodb:GetItem',
              'dynamodb:PutItem',
              'dynamodb:UpdateItem',
              'dynamodb:DeleteItem',
              'dynamodb:BatchGetItem',
              'dynamodb:BatchWriteItem'
            ],
            Resource: [
              'arn:aws:dynamodb:${self:provider.region}:*:table/templify-${self:provider.stage}-*',
              'arn:aws:dynamodb:${self:provider.region}:*:table/templify-${self:provider.stage}-*/index/*'
            ]
          },
          {
            Effect: 'Allow',
            Action: [
              's3:GetObject',
              's3:PutObject',
              's3:DeleteObject',
              's3:ListBucket'
            ],
            Resource: [
              'arn:aws:s3:::templify-${self:provider.stage}-assets',
              'arn:aws:s3:::templify-${self:provider.stage}-assets/*'
            ]
          },
          {
            Effect: 'Allow',
            Action: [
              'ses:SendEmail',
              'ses:SendRawEmail'
            ],
            Resource: '*'
          },
          {
            Effect: 'Allow',
            Action: [
              'lambda:InvokeFunction'
            ],
            Resource: [
              'arn:aws:lambda:${self:provider.region}:*:function:${self:service}-${self:provider.stage}-*'
            ]
          }
        ]
      }
    }
  },
  functions,
  package: {
    individually: true
  },
  custom: {
    esbuild: {
      bundle: true,
      minify: false,
      sourcemap: true,
      exclude: ['aws-sdk', '@sparticuz/chromium-min'],
      target: 'node20',
      define: { 'require.resolve': undefined },
      platform: 'node',
      concurrency: 10,
    },
    'serverless-offline': {
      httpPort: 3001,
      lambdaPort: 3002,
    },
    customDomain: {
      domainName: 'api.templify.com',
      stage: '${self:provider.stage}',
      basePath: '',
      certificateName: 'api.templify.com',
      createRoute53Record: true,
      endpointType: 'edge',
      securityPolicy: 'tls_1_2'
    }
  },
  layers: {
    puppeteer: {
      path: 'layers/puppeteer',
      compatibleRuntimes: ['nodejs20.x'],
      description: 'Chromium binary for PDF generation',
      retain: false
    }
  },
  resources: {
    Resources: {
      ...dynamoDbTables,
      ...s3Buckets,
      ...cognitoResources,
      ...cloudFrontDistribution,
    },
    Outputs: {
      UserPoolId: {
        Value: { Ref: 'CognitoUserPool' },
        Export: {
          Name: 'templify-${self:provider.stage}-user-pool-id'
        }
      },
      UserPoolClientId: {
        Value: { Ref: 'CognitoUserPoolClient' },
        Export: {
          Name: 'templify-${self:provider.stage}-user-pool-client-id'
        }
      },
      IdentityPoolId: {
        Value: { Ref: 'CognitoIdentityPool' },
        Export: {
          Name: 'templify-${self:provider.stage}-identity-pool-id'
        }
      },
      ApiUrl: {
        Value: {
          'Fn::Join': [
            '',
            [
              'https://',
              { Ref: 'ApiGatewayRestApi' },
              '.execute-api.',
              { Ref: 'AWS::Region' },
              '.amazonaws.com/',
              '${self:provider.stage}'
            ]
          ]
        },
        Export: {
          Name: 'templify-${self:provider.stage}-api-url'
        }
      }
    }
  }
};

module.exports = serverlessConfiguration;