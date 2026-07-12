import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { SERVER_INSTRUCTIONS } from './authoringGuide';
import { registerTools } from './tools';
import { buildWebRequest, toApiGatewayResult } from './webRequest';

const unauthorized = (): APIGatewayProxyResult => ({
  statusCode: 401,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify({
    message: 'Unauthorized: x-api-key header with a valid API token is required',
  }),
});

export const main = async (
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> => {
  context.callbackWaitsForEmptyEventLoop = false;

  const apiKey = event.headers?.['x-api-key'] || event.headers?.['X-Api-Key'];
  if (!apiKey || !apiKey.startsWith('tlfy_')) {
    return unauthorized();
  }

  const server = new McpServer(
    { name: 'mkpdfs', version: '1.0.0' },
    // Surfaced to the client on initialize — teaches agents the template
    // format up front so they don't flounder (real failure mode: an agent
    // connected, saw CRUD tools, and concluded templates "can't be
    // parameterized"). Full walkthrough: get_authoring_guide.
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, apiKey);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);

  const req = buildWebRequest(event);
  const res = await transport.handleRequest(req);
  return toApiGatewayResult(res);
};
