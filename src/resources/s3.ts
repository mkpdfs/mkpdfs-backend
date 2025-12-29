export const s3Buckets = {
  AssetsBucket: {
    Type: 'AWS::S3::Bucket',
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: {
      BucketName: 'mkpdfs-${self:provider.stage}-bucket',
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'AES256'
            }
          }
        ]
      },
      VersioningConfiguration: {
        Status: 'Enabled'
      },
      LifecycleConfiguration: {
        Rules: [
          {
            Id: 'DeleteOldPDFs',
            Status: 'Enabled',
            Prefix: 'pdfs/',
            ExpirationInDays: 30
          }
        ]
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true
      },
      CorsConfiguration: {
        CorsRules: [
          {
            AllowedHeaders: ['*'],
            AllowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'],
            AllowedOrigins: ['*'],
            ExposedHeaders: ['ETag'],
            MaxAge: 3000
          }
        ]
      }
    }
  }
};