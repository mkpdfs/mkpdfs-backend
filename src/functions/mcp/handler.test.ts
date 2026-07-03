import { describe, expect, it, vi } from 'vitest';

vi.mock('../pdf/generateApiKey/handler', () => ({
  main: vi.fn(async () => ({ statusCode: 200, body: '{}' })),
}));
vi.mock('../templates/listTemplatesApiKey/handler', () => ({
  main: vi.fn(async () => ({ statusCode: 200, body: '{"templates":[]}' })),
}));
vi.mock('../templates/getTemplateApiKey/handler', () => ({
  main: vi.fn(async () => ({ statusCode: 200, body: '{}' })),
}));
vi.mock('../templates/uploadTemplateApiKey/handler', () => ({
  main: vi.fn(async () => ({ statusCode: 201, body: '{}' })),
}));
vi.mock('../templates/updateTemplateApiKey/handler', () => ({
  main: vi.fn(async () => ({ statusCode: 200, body: '{}' })),
}));
vi.mock('../templates/deleteTemplateApiKey/handler', () => ({
  main: vi.fn(async () => ({ statusCode: 200, body: '{}' })),
}));

import { main } from './handler';

const baseEvent = (overrides: any = {}) => ({
  httpMethod: 'POST',
  path: '/v1/mcp',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-api-key': 'tlfy_test',
  },
  multiValueHeaders: {},
  queryStringParameters: null,
  multiValueQueryStringParameters: null,
  pathParameters: null,
  stageVariables: null,
  requestContext: {},
  resource: '',
  isBase64Encoded: false,
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  ...overrides,
});

describe('mcp handler.main', () => {
  it('rejects a request with no x-api-key', async () => {
    const res = await main(
      baseEvent({ headers: { 'content-type': 'application/json' } }) as any,
      {} as any,
    );
    expect(res.statusCode).toBe(401);
  });

  it('lists all 6 tools for a valid api key', async () => {
    const res = await main(baseEvent() as any, {} as any);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const names = body.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual([
      'delete_template',
      'generate_pdf',
      'get_template',
      'list_templates',
      'update_template',
      'upload_template',
    ]);
  });
});
