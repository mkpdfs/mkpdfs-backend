import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../pdf/generateApiKey/handler', () => ({
  main: vi.fn(async () => ({ statusCode: 200, body: JSON.stringify({ pdfUrl: 'https://example/pdf' }) })),
}));
vi.mock('../templates/listTemplatesApiKey/handler', () => ({
  main: vi.fn(async () => ({ statusCode: 200, body: JSON.stringify({ templates: [] }) })),
}));
vi.mock('../templates/getTemplateApiKey/handler', () => ({
  main: vi.fn(async () => ({ statusCode: 200, body: JSON.stringify({ template: {} }) })),
}));
vi.mock('../templates/uploadTemplateApiKey/handler', () => ({
  main: vi.fn(async () => ({ statusCode: 201, body: JSON.stringify({ templateId: 't1' }) })),
}));
vi.mock('../templates/updateTemplateApiKey/handler', () => ({
  main: vi.fn(async () => ({ statusCode: 200, body: JSON.stringify({ templateId: 't1' }) })),
}));
vi.mock('../templates/deleteTemplateApiKey/handler', () => ({
  main: vi.fn(async () => ({ statusCode: 200, body: JSON.stringify({ success: true }) })),
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { registerTools } from './tools';
import { main as generatePdfApiKey } from '../pdf/generateApiKey/handler';

async function callViaFreshServer(body: unknown) {
  const server = new McpServer({ name: 'mkpdfs-test', version: '0.0.0' });
  registerTools(server, 'tlfy_test');
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const req = new Request('http://localhost/v1/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  const res = await transport.handleRequest(req);
  return { status: res.status, json: JSON.parse(await res.text()) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registerTools', () => {
  it('registers exactly the 7 v1 tools', async () => {
    const { json } = await callViaFreshServer({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const names = json.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual([
      'delete_template',
      'generate_pdf',
      'get_authoring_guide',
      'get_template',
      'list_templates',
      'update_template',
      'upload_template',
    ]);
  });

  it('get_authoring_guide returns the embedded guide without touching any handler', async () => {
    const { json } = await callViaFreshServer({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'get_authoring_guide', arguments: {} },
    });
    expect(json.result.isError).toBeFalsy();
    expect(json.result.content[0].text).toContain('@page');
    expect(json.result.content[0].text).toContain('mkpdfsQR');
    expect(json.result.content[0].text).toContain('{{#each');
  });

  it('generate_pdf calls the wrapped handler with templateId/data and the api key', async () => {
    const { json } = await callViaFreshServer({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'generate_pdf', arguments: { templateId: 't1', data: { name: 'Ana' } } },
    });

    expect(json.result.isError).toBeFalsy();
    expect(json.result.content[0].text).toBe(JSON.stringify({ pdfUrl: 'https://example/pdf' }));

    const call = vi.mocked(generatePdfApiKey).mock.calls[0][0] as any;
    expect(call.headers['x-api-key']).toBe('tlfy_test');
    expect(JSON.parse(call.body)).toEqual({ templateId: 't1', data: { name: 'Ana' } });
  });

  it('list_templates takes no arguments', async () => {
    const { json } = await callViaFreshServer({
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_templates', arguments: {} },
    });
    expect(json.result.content[0].text).toBe(JSON.stringify({ templates: [] }));
  });

  it('get_template passes templateId as a path parameter', async () => {
    const { json } = await callViaFreshServer({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'get_template', arguments: { templateId: 't1' } },
    });
    expect(json.result.content[0].text).toBe(JSON.stringify({ template: {} }));
  });
});
