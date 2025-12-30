import { createHmac } from 'crypto';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);

export interface WebhookPayload {
  event: 'job.completed' | 'job.failed';
  timestamp: string;
  data: {
    jobId: string;
    status: 'completed' | 'failed';
    pdfUrl?: string;
    pageCount?: number;
    sizeBytes?: number;
    error?: string;
    errorCode?: string;
    createdAt: string;
    completedAt: string;
  };
}

export interface SendWebhookOptions {
  jobId: string;
  webhookUrl: string;
  webhookSecret?: string;
  event: 'job.completed' | 'job.failed';
  data: WebhookPayload['data'];
}

export class WebhookService {
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAYS = [1000, 2000, 4000]; // Exponential backoff: 1s, 2s, 4s
  private readonly TIMEOUT_MS = 10000; // 10 second timeout per request

  async sendWebhook(options: SendWebhookOptions): Promise<boolean> {
    const { jobId, webhookUrl, webhookSecret, event, data } = options;

    const payload: WebhookPayload = {
      event,
      timestamp: new Date().toISOString(),
      data
    };

    const payloadString = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = this.generateSignature(payloadString, timestamp, webhookSecret);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.MAX_RETRIES; attempt++) {
      try {
        // Wait before retry (not on first attempt)
        if (attempt > 0) {
          await this.delay(this.RETRY_DELAYS[attempt - 1]);
        }

        // Update attempt count in DynamoDB
        await this.updateWebhookAttempt(jobId, attempt + 1);

        // Send webhook
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.TIMEOUT_MS);

        try {
          const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Mkpdfs-Signature': signature,
              'X-Mkpdfs-Timestamp': timestamp.toString(),
              'X-Mkpdfs-Event': event,
              'User-Agent': 'Mkpdfs-Webhook/1.0'
            },
            body: payloadString,
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          // Consider 2xx responses as successful
          if (response.ok) {
            await this.updateWebhookStatus(jobId, 'delivered');
            console.log(`Webhook delivered successfully for job ${jobId}`);
            return true;
          }

          // Non-2xx response
          lastError = new Error(`Webhook returned ${response.status}: ${response.statusText}`);
          console.warn(`Webhook attempt ${attempt + 1} failed for job ${jobId}:`, lastError.message);
        } catch (fetchError) {
          clearTimeout(timeoutId);
          throw fetchError;
        }
      } catch (error) {
        lastError = error as Error;
        console.error(`Webhook attempt ${attempt + 1} failed for job ${jobId}:`, lastError.message);
      }
    }

    // All retries exhausted
    await this.updateWebhookStatus(jobId, 'failed');
    console.error(`Webhook delivery failed after ${this.MAX_RETRIES} attempts for job ${jobId}:`, lastError?.message);
    return false;
  }

  private generateSignature(payload: string, timestamp: number, secret?: string): string {
    if (!secret) {
      return 'none';
    }

    const signaturePayload = `${timestamp}.${payload}`;
    const hmac = createHmac('sha256', secret);
    hmac.update(signaturePayload);
    return `sha256=${hmac.digest('hex')}`;
  }

  private async updateWebhookAttempt(jobId: string, attempt: number): Promise<void> {
    try {
      await docClient.send(new UpdateCommand({
        TableName: process.env.JOBS_TABLE,
        Key: { jobId },
        UpdateExpression: 'SET webhookAttempts = :attempts, webhookLastAttempt = :lastAttempt, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
          ':attempts': attempt,
          ':lastAttempt': new Date().toISOString(),
          ':updatedAt': new Date().toISOString()
        }
      }));
    } catch (error) {
      console.error(`Failed to update webhook attempt for job ${jobId}:`, error);
      // Don't throw - webhook delivery is more important than tracking
    }
  }

  private async updateWebhookStatus(jobId: string, status: 'delivered' | 'failed'): Promise<void> {
    try {
      await docClient.send(new UpdateCommand({
        TableName: process.env.JOBS_TABLE,
        Key: { jobId },
        UpdateExpression: 'SET webhookStatus = :status, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
          ':status': status,
          ':updatedAt': new Date().toISOString()
        }
      }));
    } catch (error) {
      console.error(`Failed to update webhook status for job ${jobId}:`, error);
      // Don't throw - webhook delivery result is more important
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Validates a webhook URL for security
   * - Must be HTTPS
   * - Cannot be localhost, private IPs, or AWS metadata endpoints
   */
  static validateWebhookUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Invalid webhook URL format');
    }

    // Must be HTTPS
    if (parsed.protocol !== 'https:') {
      throw new Error('Webhook URL must use HTTPS');
    }

    const hostname = parsed.hostname.toLowerCase();

    // Block localhost
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') {
      throw new Error('Webhook URL cannot point to localhost');
    }

    // Block AWS metadata endpoint
    if (hostname === '169.254.169.254') {
      throw new Error('Webhook URL cannot point to AWS metadata endpoint');
    }

    // Block private IP ranges
    const privatePatterns = [
      /^10\./,           // 10.0.0.0/8
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12
      /^192\.168\./,     // 192.168.0.0/16
      /^fd[0-9a-f]{2}:/i // IPv6 ULA
    ];

    for (const pattern of privatePatterns) {
      if (pattern.test(hostname)) {
        throw new Error('Webhook URL cannot point to private IP addresses');
      }
    }
  }
}
