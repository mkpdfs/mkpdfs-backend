import type { APIGatewayProxyResult } from 'aws-lambda';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type ApiKeyHandler = (event: any, context: any) => Promise<APIGatewayProxyResult>;

export interface InvokeApiKeyHandlerOptions {
  apiKey: string;
  body?: unknown;
  pathParameters?: Record<string, string>;
}

const FAKE_CONTEXT = {};

export async function invokeApiKeyHandler(
  handler: ApiKeyHandler,
  opts: InvokeApiKeyHandlerOptions,
): Promise<CallToolResult> {
  const event = {
    httpMethod: 'POST',
    path: '',
    headers: {
      'x-api-key': opts.apiKey,
      'content-type': 'application/json',
    },
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: opts.pathParameters ?? null,
    stageVariables: null,
    requestContext: {},
    resource: '',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : null,
    isBase64Encoded: false,
  };

  const result = await handler(event, FAKE_CONTEXT);
  const isSuccess = result.statusCode >= 200 && result.statusCode < 300;

  return {
    content: [{ type: 'text', text: result.body ?? '' }],
    isError: !isSuccess,
  };
}
