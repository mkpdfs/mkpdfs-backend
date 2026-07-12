import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { buildWebRequest, toApiGatewayResult } from './webRequest';

const baseEvent = (overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent => ({
  httpMethod: 'POST',
  path: '/v1/mcp',
  headers: { 'content-type': 'application/json', 'x-api-key': 'tlfy_test' },
  multiValueHeaders: {},
  queryStringParameters: null,
  multiValueQueryStringParameters: null,
  pathParameters: null,
  stageVariables: null,
  requestContext: {} as any,
  resource: '',
  body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  isBase64Encoded: false,
  ...overrides,
});

describe('buildWebRequest', () => {
  it('carries method, headers, and body through', async () => {
    const req = buildWebRequest(baseEvent());
    expect(req.method).toBe('POST');
    expect(req.headers.get('x-api-key')).toBe('tlfy_test');
    expect(await req.text()).toBe('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
  });

  it('decodes a base64-encoded body', async () => {
    const raw = '{"jsonrpc":"2.0","id":2,"method":"tools/list"}';
    const req = buildWebRequest(baseEvent({
      body: Buffer.from(raw, 'utf-8').toString('base64'),
      isBase64Encoded: true,
    }));
    expect(await req.text()).toBe(raw);
  });

  it('builds a url that includes the event path', () => {
    const req = buildWebRequest(baseEvent({ path: '/v1/mcp' }));
    expect(req.url).toContain('/v1/mcp');
  });
});

describe('toApiGatewayResult', () => {
  it('maps status, headers, and body from a Response', async () => {
    const res = new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const result = await toApiGatewayResult(res);
    expect(result.statusCode).toBe(200);
    expect(result.headers?.['content-type']).toBe('application/json');
    expect(result.headers?.['Access-Control-Allow-Origin']).toBe('*');
    expect(result.body).toBe('{"ok":true}');
  });
});
