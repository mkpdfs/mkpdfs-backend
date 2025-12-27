export const dynamoDbTables = {
  // Users table - stores user profiles and settings
  UsersTable: {
    Type: 'AWS::DynamoDB::Table',
    Properties: {
      TableName: 'templify-${self:provider.stage}-users',
      AttributeDefinitions: [
        {
          AttributeName: 'userId',
          AttributeType: 'S'
        },
        {
          AttributeName: 'email',
          AttributeType: 'S'
        }
      ],
      KeySchema: [
        {
          AttributeName: 'userId',
          KeyType: 'HASH'
        }
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'email-index',
          KeySchema: [
            {
              AttributeName: 'email',
              KeyType: 'HASH'
            }
          ],
          Projection: {
            ProjectionType: 'ALL'
          }
        }
      ],
      BillingMode: 'PAY_PER_REQUEST',
      StreamSpecification: {
        StreamViewType: 'NEW_AND_OLD_IMAGES'
      },
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true
      }
    }
  },

  // API Tokens table
  TokensTable: {
    Type: 'AWS::DynamoDB::Table',
    Properties: {
      TableName: 'templify-${self:provider.stage}-tokens',
      AttributeDefinitions: [
        {
          AttributeName: 'token',
          AttributeType: 'S'
        },
        {
          AttributeName: 'userId',
          AttributeType: 'S'
        }
      ],
      KeySchema: [
        {
          AttributeName: 'token',
          KeyType: 'HASH'
        }
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'userId-index',
          KeySchema: [
            {
              AttributeName: 'userId',
              KeyType: 'HASH'
            }
          ],
          Projection: {
            ProjectionType: 'ALL'
          }
        }
      ],
      BillingMode: 'PAY_PER_REQUEST',
      TimeToLiveSpecification: {
        AttributeName: 'expiresAt',
        Enabled: true
      }
    }
  },

  // Usage tracking table
  UsageTable: {
    Type: 'AWS::DynamoDB::Table',
    Properties: {
      TableName: 'templify-${self:provider.stage}-usage',
      AttributeDefinitions: [
        {
          AttributeName: 'userId',
          AttributeType: 'S'
        },
        {
          AttributeName: 'yearMonth',
          AttributeType: 'S'
        }
      ],
      KeySchema: [
        {
          AttributeName: 'userId',
          KeyType: 'HASH'
        },
        {
          AttributeName: 'yearMonth',
          KeyType: 'RANGE'
        }
      ],
      BillingMode: 'PAY_PER_REQUEST'
    }
  },

  // Subscriptions table
  SubscriptionsTable: {
    Type: 'AWS::DynamoDB::Table',
    Properties: {
      TableName: 'templify-${self:provider.stage}-subscriptions',
      AttributeDefinitions: [
        {
          AttributeName: 'userId',
          AttributeType: 'S'
        }
      ],
      KeySchema: [
        {
          AttributeName: 'userId',
          KeyType: 'HASH'
        }
      ],
      BillingMode: 'PAY_PER_REQUEST',
      StreamSpecification: {
        StreamViewType: 'NEW_AND_OLD_IMAGES'
      }
    }
  },

  // Templates metadata table
  TemplatesTable: {
    Type: 'AWS::DynamoDB::Table',
    Properties: {
      TableName: 'templify-${self:provider.stage}-templates',
      AttributeDefinitions: [
        {
          AttributeName: 'userId',
          AttributeType: 'S'
        },
        {
          AttributeName: 'templateId',
          AttributeType: 'S'
        }
      ],
      KeySchema: [
        {
          AttributeName: 'userId',
          KeyType: 'HASH'
        },
        {
          AttributeName: 'templateId',
          KeyType: 'RANGE'
        }
      ],
      BillingMode: 'PAY_PER_REQUEST'
    }
  }
};