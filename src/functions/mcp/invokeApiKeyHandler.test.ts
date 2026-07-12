import { describe, expect, it } from 'vitest';
import { invokeApiKeyHandler } from './invokeApiKeyHandler';

describe('invokeApiKeyHandler', () => {
  it('builds a synthetic event carrying the api key, body, and path params', async () => {
    let seenEvent: any;
    const handler = async (event: any) => {
      seenEvent = event;
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    };

    await invokeApiKeyHandler(handler, {
      apiKey: 'tlfy_test',
      body: { templateId: 't1' },
      pathParameters: { templateId: 't1' },
    });

    expect(seenEvent.headers['x-api-key']).toBe('tlfy_test');
    expect(seenEvent.body).toBe('{"templateId":"t1"}');
    expect(seenEvent.pathParameters).toEqual({ templateId: 't1' });
  });

  it('maps a 2xx response to a non-error CallToolResult', async () => {
    const handler = async () => ({ statusCode: 200, body: '{"templates":[]}' });
    const result = await invokeApiKeyHandler(handler, { apiKey: 'tlfy_test' });
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: 'text', text: '{"templates":[]}' }]);
  });

  it('maps a non-2xx response to isError: true, keeping the body as the message', async () => {
    const handler = async () => ({
      statusCode: 402,
      body: JSON.stringify({ error: 'INSUFFICIENT_CREDITS' }),
    });
    const result = await invokeApiKeyHandler(handler, { apiKey: 'tlfy_test' });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: 'text', text: '{"error":"INSUFFICIENT_CREDITS"}' });
  });

  it('sends a null body when no body is given (GET-shaped tools)', async () => {
    let seenEvent: any;
    const handler = async (event: any) => {
      seenEvent = event;
      return { statusCode: 200, body: '{}' };
    };
    await invokeApiKeyHandler(handler, { apiKey: 'tlfy_test' });
    expect(seenEvent.body).toBeNull();
  });
});
