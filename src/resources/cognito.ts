export const cognitoResources = {
  CognitoUserPool: {
    Type: 'AWS::Cognito::UserPool',
    Properties: {
      UserPoolName: 'templify-${self:provider.stage}-user-pool',
      UsernameAttributes: ['email'],
      AutoVerifiedAttributes: ['email'],
      Schema: [
        {
          Name: 'email',
          AttributeDataType: 'String',
          Required: true,
          Mutable: true
        },
        {
          Name: 'name',
          AttributeDataType: 'String',
          Required: false,
          Mutable: true
        }
      ],
      Policies: {
        PasswordPolicy: {
          MinimumLength: 8,
          RequireLowercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
          RequireUppercase: true
        }
      },
      MfaConfiguration: 'OPTIONAL',
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
      UserPoolAddOns: {
        AdvancedSecurityMode: 'ENFORCED'
      },
      AccountRecoverySetting: {
        RecoveryMechanisms: [
          {
            Name: 'verified_email',
            Priority: 1
          }
        ]
      }
    }
  },

  // User Pool Domain (required for OAuth hosted UI)
  CognitoUserPoolDomain: {
    Type: 'AWS::Cognito::UserPoolDomain',
    Properties: {
      Domain: 'templify-${self:provider.stage}',
      UserPoolId: { Ref: 'CognitoUserPool' }
    }
  },

  // Google Identity Provider
  CognitoUserPoolIdentityProviderGoogle: {
    Type: 'AWS::Cognito::UserPoolIdentityProvider',
    Properties: {
      UserPoolId: { Ref: 'CognitoUserPool' },
      ProviderName: 'Google',
      ProviderType: 'Google',
      ProviderDetails: {
        client_id: '{{resolve:ssm:/templify/${self:provider.stage}/google-oauth/client-id}}',
        client_secret: '{{resolve:ssm:/templify/${self:provider.stage}/google-oauth/client-secret}}',
        authorize_scopes: 'openid email profile'
      },
      AttributeMapping: {
        email: 'email',
        name: 'name'
      }
    }
  },

  CognitoUserPoolClient: {
    Type: 'AWS::Cognito::UserPoolClient',
    DependsOn: ['CognitoUserPoolIdentityProviderGoogle'],
    Properties: {
      ClientName: 'templify-${self:provider.stage}-web-client',
      UserPoolId: {
        Ref: 'CognitoUserPool'
      },
      ExplicitAuthFlows: [
        'ALLOW_USER_PASSWORD_AUTH',
        'ALLOW_USER_SRP_AUTH',
        'ALLOW_REFRESH_TOKEN_AUTH'
      ],
      GenerateSecret: false,
      PreventUserExistenceErrors: 'ENABLED',
      SupportedIdentityProviders: ['COGNITO', 'Google'],
      AllowedOAuthFlows: ['code'],
      AllowedOAuthScopes: ['openid', 'email', 'profile', 'aws.cognito.signin.user.admin'],
      AllowedOAuthFlowsUserPoolClient: true,
      CallbackURLs: [
        'http://localhost:3000/callback',
        'https://app.templifying.com/callback',
        'https://dev.app.templifying.com/callback',
        'https://stage.app.templifying.com/callback'
      ],
      LogoutURLs: [
        'http://localhost:3000/logout',
        'https://app.templifying.com/logout',
        'https://dev.app.templifying.com/logout',
        'https://stage.app.templifying.com/logout'
      ],
      RefreshTokenValidity: 30,
      AccessTokenValidity: 60,
      IdTokenValidity: 60,
      TokenValidityUnits: {
        AccessToken: 'minutes',
        IdToken: 'minutes',
        RefreshToken: 'days'
      }
    }
  },

  CognitoIdentityPool: {
    Type: 'AWS::Cognito::IdentityPool',
    Properties: {
      IdentityPoolName: 'templify_${self:provider.stage}_identity_pool',
      AllowUnauthenticatedIdentities: false,
      CognitoIdentityProviders: [
        {
          ClientId: {
            Ref: 'CognitoUserPoolClient'
          },
          ProviderName: {
            'Fn::GetAtt': ['CognitoUserPool', 'ProviderName']
          }
        }
      ]
    }
  },

  CognitoIdentityPoolRoles: {
    Type: 'AWS::Cognito::IdentityPoolRoleAttachment',
    Properties: {
      IdentityPoolId: {
        Ref: 'CognitoIdentityPool'
      },
      Roles: {
        authenticated: {
          'Fn::GetAtt': ['CognitoAuthRole', 'Arn']
        }
      }
    }
  },

  CognitoAuthRole: {
    Type: 'AWS::IAM::Role',
    Properties: {
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              Federated: 'cognito-identity.amazonaws.com'
            },
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'cognito-identity.amazonaws.com:aud': {
                  Ref: 'CognitoIdentityPool'
                }
              },
              'ForAnyValue:StringLike': {
                'cognito-identity.amazonaws.com:amr': 'authenticated'
              }
            }
          }
        ]
      },
      Policies: [
        {
          PolicyName: 'CognitoAuthorizedPolicy',
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: [
                  'mobileanalytics:PutEvents',
                  'cognito-sync:*',
                  'cognito-identity:*'
                ],
                Resource: '*'
              },
              {
                Effect: 'Allow',
                Action: [
                  'execute-api:Invoke'
                ],
                Resource: [
                  {
                    'Fn::Join': [
                      '',
                      [
                        'arn:aws:execute-api:',
                        { Ref: 'AWS::Region' },
                        ':',
                        { Ref: 'AWS::AccountId' },
                        ':',
                        { Ref: 'ApiGatewayRestApi' },
                        '/*'
                      ]
                    ]
                  }
                ]
              }
            ]
          }
        }
      ]
    }
  }
};