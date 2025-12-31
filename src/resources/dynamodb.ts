export const dynamoDbTables = {
  // Users table - stores user profiles and settings
  UsersTable: {
    Type: 'AWS::DynamoDB::Table',
    Properties: {
      TableName: 'mkpdfs-${self:provider.stage}-users',
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
      TableName: 'mkpdfs-${self:provider.stage}-tokens',
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
      TableName: 'mkpdfs-${self:provider.stage}-usage',
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
      TableName: 'mkpdfs-${self:provider.stage}-subscriptions',
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
      TableName: 'mkpdfs-${self:provider.stage}-templates',
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
  },

  // Marketplace templates table - platform-owned public templates
  MarketplaceTable: {
    Type: 'AWS::DynamoDB::Table',
    Properties: {
      TableName: 'mkpdfs-${self:provider.stage}-marketplace',
      AttributeDefinitions: [
        {
          AttributeName: 'templateId',
          AttributeType: 'S'
        },
        {
          AttributeName: 'category',
          AttributeType: 'S'
        }
      ],
      KeySchema: [
        {
          AttributeName: 'templateId',
          KeyType: 'HASH'
        }
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'category-index',
          KeySchema: [
            {
              AttributeName: 'category',
              KeyType: 'HASH'
            }
          ],
          Projection: {
            ProjectionType: 'ALL'
          }
        }
      ],
      BillingMode: 'PAY_PER_REQUEST'
    }
  },

  // Jobs table - async PDF generation job tracking
  JobsTable: {
    Type: 'AWS::DynamoDB::Table',
    Properties: {
      TableName: 'mkpdfs-${self:provider.stage}-jobs',
      AttributeDefinitions: [
        {
          AttributeName: 'jobId',
          AttributeType: 'S'
        },
        {
          AttributeName: 'userId',
          AttributeType: 'S'
        },
        {
          AttributeName: 'createdAt',
          AttributeType: 'S'
        }
      ],
      KeySchema: [
        {
          AttributeName: 'jobId',
          KeyType: 'HASH'
        }
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'userId-createdAt-index',
          KeySchema: [
            {
              AttributeName: 'userId',
              KeyType: 'HASH'
            },
            {
              AttributeName: 'createdAt',
              KeyType: 'RANGE'
            }
          ],
          Projection: {
            ProjectionType: 'ALL'
          }
        }
      ],
      BillingMode: 'PAY_PER_REQUEST',
      TimeToLiveSpecification: {
        AttributeName: 'ttl',
        Enabled: true
      }
    }
  },

  // Rate limits table - tracks rate limiting by IP for public endpoints
  RateLimitsTable: {
    Type: 'AWS::DynamoDB::Table',
    Properties: {
      TableName: 'mkpdfs-${self:provider.stage}-rate-limits',
      AttributeDefinitions: [
        {
          AttributeName: 'pk',
          AttributeType: 'S'
        },
        {
          AttributeName: 'sk',
          AttributeType: 'S'
        }
      ],
      KeySchema: [
        {
          AttributeName: 'pk',
          KeyType: 'HASH'
        },
        {
          AttributeName: 'sk',
          KeyType: 'RANGE'
        }
      ],
      BillingMode: 'PAY_PER_REQUEST',
      TimeToLiveSpecification: {
        AttributeName: 'ttl',
        Enabled: true
      }
    }
  }
};