import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { EnvConfig, bucketName } from '../config';

export interface StorageStackProps extends cdk.StackProps {
  cfg: EnvConfig;
}

/**
 * Assets bucket (templates, generated PDFs, marketplace thumbnails,
 * lambda-layers/). OWNED by CDK with the same physical name and settings as
 * the Serverless resource (inventory section (d)): versioning, AES256,
 * lifecycle pdfs/ 30d, CORS *, public-read policy for marketplace thumbnails.
 *
 * RemovalPolicy: RETAIN in prod, DESTROY (+autoDeleteObjects) in dev.
 */
export class StorageStack extends cdk.Stack {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    const { cfg } = props;

    this.bucket = new s3.Bucket(this, 'AssetsBucket', {
      bucketName: bucketName(cfg.environment),
      encryption: s3.BucketEncryption.S3_MANAGED, // AES256
      versioned: true,
      lifecycleRules: [
        {
          id: 'DeleteOldPDFs',
          enabled: true,
          prefix: 'pdfs/',
          expiration: cdk.Duration.days(30),
        },
      ],
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: true,
        blockPublicPolicy: false, // the thumbnails policy below must be allowed
        ignorePublicAcls: true,
        restrictPublicBuckets: false,
      }),
      cors: [
        {
          allowedHeaders: ['*'],
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.PUT,
            s3.HttpMethods.POST,
            s3.HttpMethods.DELETE,
            s3.HttpMethods.HEAD,
          ],
          allowedOrigins: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
      removalPolicy: cfg.isProd
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !cfg.isProd,
    });

    // Public read for marketplace thumbnails (same two Sids as the legacy policy)
    this.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'PublicReadMarketplaceThumbnails',
        effect: iam.Effect.ALLOW,
        principals: [new iam.StarPrincipal()],
        actions: ['s3:GetObject'],
        resources: [this.bucket.arnForObjects('marketplace/thumbnails/*')],
      }),
    );
    this.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'PublicReadMarketplaceThumbnailsFull',
        effect: iam.Effect.ALLOW,
        principals: [new iam.StarPrincipal()],
        actions: ['s3:GetObject'],
        resources: [this.bucket.arnForObjects('marketplace/thumbnails-full/*')],
      }),
    );

    new cdk.CfnOutput(this, 'AssetsBucketName', {
      value: this.bucket.bucketName,
      description: 'Assets bucket (templates, PDFs, thumbnails, lambda-layers/)',
    });
  }
}
