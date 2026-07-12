import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rum from 'aws-cdk-lib/aws-rum';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { EnvConfig } from '../config';
import { MkpdfsTables } from './database-stack';

export interface MonitoringStackProps extends cdk.StackProps {
  cfg: EnvConfig;
  api: apigateway.RestApi;
  tables: MkpdfsTables;
  dlqs: { pdfGeneration: sqs.IQueue; aiGeneration: sqs.IQueue };
  /** Billing-critical lambdas (credits flow). */
  billingFns: {
    stripeWebhook: lambda.IFunction;
    generatePdf: lambda.IFunction;
    generatePdfApiKey: lambda.IFunction;
    processJob: lambda.IFunction;
  };
  alertEmail: string;
}

/**
 * Alarms + dashboard with a bias toward the CREDITS BILLING flow: a broken
 * Stripe webhook means purchases stop crediting (customer-visible money bug),
 * a failed debit means free PDFs, a failed auto-recharge means a paying
 * customer just lost their top-up. Standard API/DDB/DLQ coverage included.
 *
 * Log metric filters key off the literal log strings emitted by the handlers
 * (webhook handler + credits middleware/service) — if those messages are
 * reworded, update the filter patterns here.
 */
export class MonitoringStack extends cdk.Stack {
  public readonly alertsTopic: sns.Topic;
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    const { cfg, api, tables, dlqs, billingFns, alertEmail } = props;
    const env = cfg.environment;
    const allAlarms: cloudwatch.Alarm[] = [];

    // ----------------------------------------------------------------
    // SNS topic for alerts
    // ----------------------------------------------------------------
    this.alertsTopic = new sns.Topic(this, 'AlertsTopic', {
      topicName: `mkpdfs-alerts-${env}`,
      displayName: `mkpdfs Monitoring Alerts (${env})`,
    });
    this.alertsTopic.addSubscription(new sns_subscriptions.EmailSubscription(alertEmail));

    const alarm = (
      idSuffix: string,
      props_: cloudwatch.AlarmProps,
      okAction = false,
    ): cloudwatch.Alarm => {
      const a = new cloudwatch.Alarm(this, idSuffix, {
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        ...props_,
      });
      a.addAlarmAction(new cw_actions.SnsAction(this.alertsTopic));
      if (okAction) a.addOkAction(new cw_actions.SnsAction(this.alertsTopic));
      allAlarms.push(a);
      return a;
    };

    // ----------------------------------------------------------------
    // Billing-critical: Stripe webhook
    // ----------------------------------------------------------------
    // Any handler crash = a Stripe event (purchase/recharge/refund) was NOT
    // applied. Stripe retries, but sustained errors need a human.
    alarm('StripeWebhookErrors', {
      alarmName: `mkpdfs-stripe-webhook-errors-${env}`,
      alarmDescription:
        'Stripe webhook lambda errored — purchases/recharges/refunds may not be crediting',
      metric: billingFns.stripeWebhook.metricErrors({
        period: cdk.Duration.minutes(1),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
    }, true);

    // Log-based billing signals. The handlers return 200/400 on these paths
    // (no lambda error), so only the log line reveals them.
    const billingMetric = (
      idSuffix: string,
      fn: lambda.IFunction,
      pattern: string,
      metricName: string,
    ): cloudwatch.Metric => {
      const logGroup = logs.LogGroup.fromLogGroupName(
        this,
        `${idSuffix}LogGroup`,
        `/aws/lambda/${fn.functionName}`,
      );
      new logs.MetricFilter(this, `${idSuffix}Filter`, {
        logGroup,
        filterPattern: logs.FilterPattern.literal(pattern),
        metricNamespace: 'MkpdfsBilling',
        metricName: `${metricName}-${env}`,
        metricValue: '1',
      });
      return new cloudwatch.Metric({
        namespace: 'MkpdfsBilling',
        metricName: `${metricName}-${env}`,
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      });
    };

    // Signature failures: occasional scanner noise is normal; a burst means
    // the webhook secret rotated/diverged and ALL events are bouncing.
    alarm('WebhookSignatureFailures', {
      alarmName: `mkpdfs-webhook-signature-failures-${env}`,
      alarmDescription:
        'Stripe webhook signature verification failing repeatedly — secret mismatch? No events are being applied.',
      metric: billingMetric(
        'SigFail',
        billingFns.stripeWebhook,
        '"Webhook signature verification failed"',
        'WebhookSignatureFailures',
      ),
      threshold: 3,
      evaluationPeriods: 1,
    });

    // A customer's auto-recharge card was declined (handler logs and disables
    // it). One alert per occurrence: each one is a paying customer to contact.
    alarm('AutoRechargeFailures', {
      alarmName: `mkpdfs-auto-recharge-failed-${env}`,
      alarmDescription:
        'Auto-recharge payment failed for a customer (card declined) — auto-recharge was disabled for them',
      metric: billingMetric(
        'RechargeFail',
        billingFns.stripeWebhook,
        '"Auto-recharge FAILED"',
        'AutoRechargeFailures',
      ),
      threshold: 1,
      evaluationPeriods: 1,
    });

    // Debit failures = PDFs delivered without charging credits (revenue leak).
    const debitFailMetrics = [
      ['DebitFailSync', billingFns.generatePdf],
      ['DebitFailApiKey', billingFns.generatePdfApiKey],
    ] as const;
    for (const [idSuffix, fn] of debitFailMetrics) {
      alarm(`${idSuffix}Alarm`, {
        alarmName: `mkpdfs-${idSuffix.toLowerCase()}-${env}`,
        alarmDescription: 'Credit debit failed after a successful PDF (revenue leak)',
        metric: billingMetric(idSuffix, fn, '"[credits] debit failed"', idSuffix),
        threshold: 1,
        evaluationPeriods: 1,
      });
    }
    alarm('DebitFailJobAlarm', {
      alarmName: `mkpdfs-debitfailjob-${env}`,
      alarmDescription: 'Async job credit debit failed after delivering the PDF (revenue leak)',
      metric: billingMetric(
        'DebitFailJob',
        billingFns.processJob,
        '"Failed to debit credits for job"',
        'DebitFailJob',
      ),
      threshold: 1,
      evaluationPeriods: 1,
    });

    // ----------------------------------------------------------------
    // API Gateway
    // ----------------------------------------------------------------
    alarm('Api5xx', {
      alarmName: `mkpdfs-api-5xx-${env}`,
      alarmDescription: 'API Gateway returning 5xx errors',
      metric: api.metricServerError({ period: cdk.Duration.minutes(1), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
    }, true);

    alarm('Api4xxRate', {
      alarmName: `mkpdfs-api-4xx-rate-${env}`,
      alarmDescription: 'Sustained 4xx error rate (attack or client bug)',
      metric: api.metricClientError({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 50,
      evaluationPeriods: 2,
    });

    alarm('ApiLatencyP99', {
      alarmName: `mkpdfs-api-latency-p99-${env}`,
      alarmDescription: 'API p99 latency above 5s for 15 minutes',
      metric: api.metricLatency({ period: cdk.Duration.minutes(5), statistic: 'p99' }),
      threshold: 5000,
      evaluationPeriods: 3,
    });

    // ----------------------------------------------------------------
    // DynamoDB throttles — the tables the billing flow writes on every PDF
    // ----------------------------------------------------------------
    const billingTables = {
      subscriptions: tables.subscriptions,
      creditLedger: tables.creditLedger,
      tokens: tables.tokens,
      usage: tables.usage,
    };
    for (const [name, table] of Object.entries(billingTables)) {
      alarm(`Throttle_${name}`, {
        alarmName: `mkpdfs-ddb-throttle-${name}-${env}`,
        alarmDescription: `DynamoDB ${name} table throttling — billing operations may fail`,
        metric: table.metricThrottledRequestsForOperations({
          operations: [
            dynamodb.Operation.GET_ITEM,
            dynamodb.Operation.QUERY,
            dynamodb.Operation.PUT_ITEM,
            dynamodb.Operation.UPDATE_ITEM,
            dynamodb.Operation.TRANSACT_WRITE_ITEMS,
          ],
          period: cdk.Duration.minutes(1),
        }),
        threshold: 1,
        evaluationPeriods: 1,
      });
    }

    // ----------------------------------------------------------------
    // SQS dead-letter queues
    // ----------------------------------------------------------------
    for (const [name, dlq] of Object.entries(dlqs)) {
      alarm(`Dlq_${name}`, {
        alarmName: `mkpdfs-dlq-${name}-${env}`,
        alarmDescription: `Messages in the ${name} DLQ — jobs failed after retries`,
        metric: dlq.metricApproximateNumberOfMessagesVisible({
          period: cdk.Duration.minutes(1),
        }),
        threshold: 1,
        evaluationPeriods: 1,
      });
    }

    // ----------------------------------------------------------------
    // CloudWatch RUM — real-user monitoring for mkpdfs-web
    // ----------------------------------------------------------------
    // The browser client (aws-rum-web) signs PutRumEvents as a GUEST of a
    // dedicated identity pool — deliberately separate from the app's auth
    // pool so telemetry credentials never mix with dashboard sessions.
    // aws-rum-web does NOT capture console.* on its own: JS errors/http/
    // vitals come from its telemetries, and the frontend rum-logger forwards
    // structured [Area] logs as custom events (hence customEvents ENABLED).
    const appMonitorName = `mkpdfs-web-${env}`;

    const rumIdentityPool = new cognito.CfnIdentityPool(this, 'RumIdentityPool', {
      identityPoolName: `mkpdfs-rum-${env}`,
      allowUnauthenticatedIdentities: true,
    });

    const rumGuestRole = new iam.Role(this, 'RumGuestRole', {
      roleName: `mkpdfs-rum-guest-${env}`,
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: { 'cognito-identity.amazonaws.com:aud': rumIdentityPool.ref },
          'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'unauthenticated' },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
    });
    rumGuestRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['rum:PutRumEvents'],
        resources: [`arn:aws:rum:${this.region}:${this.account}:appmonitor/${appMonitorName}`],
      }),
    );

    new cognito.CfnIdentityPoolRoleAttachment(this, 'RumIdentityPoolRoles', {
      identityPoolId: rumIdentityPool.ref,
      roles: { unauthenticated: rumGuestRole.roleArn },
    });

    const appMonitor = new rum.CfnAppMonitor(this, 'WebAppMonitor', {
      name: appMonitorName,
      // RUM rejects events from origins outside this list. www is a real
      // Amplify subdomain (www prefix → main branch), so prod needs both.
      domainList: cfg.isProd
        ? ['mkpdfs.com', 'www.mkpdfs.com']
        : ['dev.mkpdfs.com', 'localhost'],
      cwLogEnabled: true, // also lands in CW Logs → queryable with Logs Insights
      customEvents: { status: 'ENABLED' },
      appMonitorConfiguration: {
        identityPoolId: rumIdentityPool.ref,
        guestRoleArn: rumGuestRole.roleArn,
        allowCookies: true,
        enableXRay: false,
        sessionSampleRate: 1,
        telemetries: ['errors', 'performance', 'http'],
      },
    });

    // The identity pool is public by design (guest PutRumEvents), so ingest
    // volume is the abuse surface: someone scripting the guest role can only
    // spam events, and this catches it. ~10 MB/h is far above organic traffic.
    alarm('RumIngestSpike', {
      alarmName: `mkpdfs-rum-ingest-spike-${env}`,
      alarmDescription:
        'CloudWatch RUM ingest volume spike — possible telemetry abuse via the public guest identity pool',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/RUM',
        metricName: 'RumEventPayloadSize',
        dimensionsMap: { application_name: appMonitorName },
        period: cdk.Duration.hours(1),
        statistic: 'Sum',
      }),
      threshold: 10_000_000,
      evaluationPeriods: 1,
    });

    // ----------------------------------------------------------------
    // Dashboard
    // ----------------------------------------------------------------
    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `mkpdfs-operations-${env}`,
    });

    const billingNs = (metricName: string) =>
      new cloudwatch.Metric({
        namespace: 'MkpdfsBilling',
        metricName: `${metricName}-${env}`,
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      });

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Billing — Stripe webhook',
        left: [
          billingFns.stripeWebhook.metricInvocations({ period: cdk.Duration.minutes(5), label: 'events' }),
          billingFns.stripeWebhook.metricErrors({ period: cdk.Duration.minutes(5), label: 'errors' }),
          billingNs('WebhookSignatureFailures').with({ label: 'bad signatures' }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Billing — incidents',
        left: [
          billingNs('AutoRechargeFailures').with({ label: 'recharge declined' }),
          billingNs('DebitFailSync').with({ label: 'debit fail (sync)' }),
          billingNs('DebitFailApiKey').with({ label: 'debit fail (api-key)' }),
          billingNs('DebitFailJob').with({ label: 'debit fail (jobs)' }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Credit ledger writes',
        left: [
          tables.creditLedger.metricConsumedWriteCapacityUnits({
            period: cdk.Duration.minutes(5),
            label: 'ledger WCU',
          }),
          tables.subscriptions.metricConsumedWriteCapacityUnits({
            period: cdk.Duration.minutes(5),
            label: 'subscriptions WCU',
          }),
        ],
        width: 8,
        height: 6,
      }),
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API requests',
        left: [api.metricCount({ period: cdk.Duration.minutes(5) })],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'API errors',
        left: [
          api.metricClientError({ period: cdk.Duration.minutes(5), label: '4xx' }),
          api.metricServerError({ period: cdk.Duration.minutes(5), label: '5xx' }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'API latency',
        left: [
          api.metricLatency({ period: cdk.Duration.minutes(5), statistic: 'p50', label: 'p50' }),
          api.metricLatency({ period: cdk.Duration.minutes(5), statistic: 'p99', label: 'p99' }),
        ],
        width: 8,
        height: 6,
      }),
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'DLQs',
        left: Object.entries(dlqs).map(([name, dlq]) =>
          dlq.metricApproximateNumberOfMessagesVisible({
            period: cdk.Duration.minutes(5),
            label: name,
          }),
        ),
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'PDF job processor',
        left: [
          billingFns.processJob.metricInvocations({ period: cdk.Duration.minutes(5), label: 'jobs' }),
          billingFns.processJob.metricErrors({ period: cdk.Duration.minutes(5), label: 'errors' }),
        ],
        width: 12,
        height: 6,
      }),
    );

    this.dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({
        title: 'Alarm status',
        alarms: allAlarms,
        width: 24,
        height: 4,
      }),
    );

    // ----------------------------------------------------------------
    // Outputs
    // ----------------------------------------------------------------
    new cdk.CfnOutput(this, 'RumAppMonitorId', {
      value: appMonitor.attrId,
      description: 'NEXT_PUBLIC_RUM_APP_MONITOR_ID for mkpdfs-web (Amplify env var)',
    });
    new cdk.CfnOutput(this, 'RumIdentityPoolId', {
      value: rumIdentityPool.ref,
      description: 'NEXT_PUBLIC_RUM_IDENTITY_POOL_ID for mkpdfs-web (Amplify env var)',
    });
    new cdk.CfnOutput(this, 'RumGuestRoleArn', {
      value: rumGuestRole.roleArn,
      description: 'RUM guest role (reference only — the web client uses the enhanced auth flow and needs just the identity pool id)',
    });
    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${this.dashboard.dashboardName}`,
      description: 'CloudWatch dashboard URL',
    });
    new cdk.CfnOutput(this, 'AlertsTopicArn', {
      value: this.alertsTopic.topicArn,
      description: 'SNS topic for alerts (add Slack/PagerDuty subscriptions here)',
    });
  }
}
