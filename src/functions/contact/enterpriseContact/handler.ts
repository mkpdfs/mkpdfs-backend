import { APIGatewayProxyHandler } from 'aws-lambda';
import { formatJSONResponse, formatErrorResponse } from '@libs/apiGateway';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { TwilioService } from '@libs/services/twilioService';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const ssmClient = new SSMClient({});

const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

interface ContactRequest {
  name: string;
  email: string;
  message: string;
}

function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function getSSMParameter(name: string): Promise<string> {
  const response = await ssmClient.send(new GetParameterCommand({
    Name: name,
    WithDecryption: true
  }));
  return response.Parameter?.Value || '';
}

async function checkRateLimit(ip: string): Promise<{ allowed: boolean; remaining: number }> {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  const result = await docClient.send(new GetCommand({
    TableName: process.env.RATE_LIMIT_TABLE!,
    Key: { pk: `CONTACT#${ip}`, sk: 'enterprise' }
  }));

  const item = result.Item;
  if (!item || item.windowStart < windowStart) {
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }

  if (item.count >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0 };
  }

  return { allowed: true, remaining: RATE_LIMIT_MAX - item.count - 1 };
}

async function updateRateLimit(ip: string): Promise<void> {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const ttl = Math.floor((now + RATE_LIMIT_WINDOW_MS) / 1000);

  // Get current item to check if window needs reset
  const result = await docClient.send(new GetCommand({
    TableName: process.env.RATE_LIMIT_TABLE!,
    Key: { pk: `CONTACT#${ip}`, sk: 'enterprise' }
  }));

  const item = result.Item;
  const needsReset = !item || item.windowStart < windowStart;

  await docClient.send(new UpdateCommand({
    TableName: process.env.RATE_LIMIT_TABLE!,
    Key: { pk: `CONTACT#${ip}`, sk: 'enterprise' },
    UpdateExpression: needsReset
      ? 'SET #count = :one, windowStart = :now, #ttl = :ttl'
      : 'SET #count = #count + :one, #ttl = :ttl',
    ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
    ExpressionAttributeValues: needsReset
      ? { ':one': 1, ':now': now, ':ttl': ttl }
      : { ':one': 1, ':ttl': ttl }
  }));
}

export const main: APIGatewayProxyHandler = async (event) => {
  try {
    const ip = event.requestContext.identity?.sourceIp || 'unknown';

    // Parse and validate request
    let body: ContactRequest;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return formatJSONResponse({ message: 'Invalid JSON body' }, 400);
    }

    const { name, email, message } = body;

    if (!name || name.trim().length < 2) {
      return formatJSONResponse({ message: 'Name is required (min 2 characters)' }, 400);
    }
    if (!email || !validateEmail(email)) {
      return formatJSONResponse({ message: 'Valid email is required' }, 400);
    }
    if (!message || message.trim().length < 10) {
      return formatJSONResponse({ message: 'Message is required (min 10 characters)' }, 400);
    }

    // Check rate limit
    const { allowed, remaining } = await checkRateLimit(ip);
    if (!allowed) {
      return formatJSONResponse(
        { message: 'Rate limit exceeded. Please try again later.' },
        429
      );
    }

    // Get Twilio config from SSM
    const stage = process.env.STAGE || 'dev';
    const [accountSid, apiKeySid, apiKeySecret, fromNumber, toNumber] = await Promise.all([
      getSSMParameter(`/mkpdfs/${stage}/twilio-account-sid`),
      getSSMParameter(`/mkpdfs/${stage}/twilio-api-key-sid`),
      getSSMParameter(`/mkpdfs/${stage}/twilio-api-key-secret`),
      getSSMParameter(`/mkpdfs/${stage}/twilio-from-number`),
      getSSMParameter(`/mkpdfs/${stage}/enterprise-contact-phone`)
    ]);

    if (!accountSid || !apiKeySid || !apiKeySecret || !fromNumber || !toNumber) {
      console.error('Missing Twilio configuration in SSM');
      return formatErrorResponse(new Error('Service temporarily unavailable'));
    }

    // Send SMS via Twilio
    const twilioService = new TwilioService(accountSid, apiKeySid, apiKeySecret, fromNumber);
    const smsMessage = `New Enterprise Contact:

Name: ${name.trim()}
Email: ${email.trim()}

Message:
${message.trim()}`;

    await twilioService.sendSMS(toNumber, smsMessage);

    // Update rate limit after successful send
    await updateRateLimit(ip);

    console.log(`Enterprise contact submitted: ${email}`);

    return formatJSONResponse({
      success: true,
      message: 'Your message has been sent. Our team will contact you shortly.',
      remaining
    });
  } catch (error) {
    console.error('Error processing enterprise contact:', error);
    return formatErrorResponse(error as Error);
  }
};
