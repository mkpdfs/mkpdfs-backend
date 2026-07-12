# MCP server (`POST /v1/mcp`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose `generate_pdf` + template CRUD as MCP tools over a new `POST /v1/mcp` Lambda, so external services/agents can drive mkpdfs via the Model Context Protocol using the same `x-api-key: tlfy_*` credential the REST API already accepts.

**Architecture:** One new Lambda (`src/functions/mcp/handler.ts`) builds a fresh `McpServer` + `WebStandardStreamableHTTPServerTransport` (stateless, one pair per invocation) per request, registers 6 tools, and each tool dispatches by building a synthetic `APIGatewayProxyEvent` and calling the *already-exported* `main` handler from the matching `*ApiKey` route in-process (no network hop) — so auth, credit checks, subscription limits, and usage tracking stay guaranteed-identical to the REST surface.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` (`WebStandardStreamableHTTPServerTransport`, Web Fetch API `Request`/`Response` — no Node `http` shim needed, verified against the real package), `zod` for tool input schemas, AWS CDK (`NodejsFunction`), vitest.

## Global Constraints

- API-key only auth: every request must carry `x-api-key: tlfy_*`; `Authorization: Bearer` is never consulted (mirrors `/v1/pdf/generate` and `/v1/templates/*` — no Gateway authorizer on this route).
- No new business logic. Every tool is a thin adapter over an existing, already-shipped `*ApiKey` handler — reuse it in-process, do not reimplement auth/credits/subscription/usage-tracking.
- `generate_pdf` is synchronous only — do not expose the REST route's `async`/`sendEmail` params.
- One Lambda (`McpFn`), one route (`POST /v1/mcp`), added to the existing `ApiStack` — no new CDK stack.
- `McpFn` needs the combined footprint of `GeneratePdfApiKeyFn` + the 5 template `*ApiKey` functions: Chromium layer, 4096 MB memory, 30s timeout, and the union of their IAM grants (see Task 6).
- Deep-import the SDK from its subpaths (`@modelcontextprotocol/sdk/server/mcp.js`, `.../webStandardStreamableHttp.js`, `.../types.js`) — the package's `.`/`./server` barrel exports do **not** re-export `McpServer` or the transport class, and deep imports also keep esbuild from pulling in the SDK's bundled Express/Hono dependencies that this project never uses.
- Full source: `docs/superpowers/specs/2026-07-03-mcp-server-design.md`.

---

### Task 1: Add MCP SDK dependencies

**Files:**
- Modify: `mkpdfs-backend/package.json`

**Interfaces:**
- Produces: `@modelcontextprotocol/sdk` and `zod` become resolvable from anywhere under `mkpdfs-backend/src` — every later task's imports depend on this.

- [ ] **Step 1: Add the two dependencies to `package.json`**

In the `"dependencies"` block (anywhere alongside the existing `@aws-sdk/*` entries), add:

```json
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^4.4.3",
```

- [ ] **Step 2: Install and lock**

Run (from `mkpdfs-backend/`):
```bash
npm install
```
Expected: `package-lock.json` is updated with `@modelcontextprotocol/sdk` and `zod` entries; no errors.

- [ ] **Step 3: Verify the deep-import paths this plan relies on actually resolve**

Run:
```bash
node -e "
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { WebStandardStreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js');
console.log('OK', typeof McpServer, typeof WebStandardStreamableHTTPServerTransport);
"
```
Expected: `OK function function`

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @modelcontextprotocol/sdk + zod for the MCP server"
```

---

### Task 2: `webRequest.ts` — API Gateway ↔ Web Fetch bridging

**Files:**
- Create: `mkpdfs-backend/src/functions/mcp/webRequest.ts`
- Test: `mkpdfs-backend/src/functions/mcp/webRequest.test.ts`

**Interfaces:**
- Produces:
  - `buildWebRequest(event: APIGatewayProxyEvent): Request`
  - `toApiGatewayResult(res: Response): Promise<APIGatewayProxyResult>`
  - Used directly by Task 5 (`handler.ts`).

- [ ] **Step 1: Write the failing test**

Create `mkpdfs-backend/src/functions/mcp/webRequest.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/functions/mcp/webRequest.test.ts`
Expected: FAIL — `Cannot find module './webRequest'` (or similar resolution error; the file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `mkpdfs-backend/src/functions/mcp/webRequest.ts`:

```typescript
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

export function buildWebRequest(event: APIGatewayProxyEvent): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers || {})) {
    if (value != null) headers.set(key, value);
  }

  const host = event.headers?.['Host'] || event.headers?.['host'] || 'mkpdfs.internal';
  const url = `https://${host}${event.path}`;

  const rawBody = event.body
    ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body)
    : undefined;

  return new Request(url, {
    method: event.httpMethod,
    headers,
    body: rawBody,
  });
}

export async function toApiGatewayResult(res: Response): Promise<APIGatewayProxyResult> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
  };
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    statusCode: res.status,
    headers,
    body: await res.text(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/functions/mcp/webRequest.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/functions/mcp/webRequest.ts src/functions/mcp/webRequest.test.ts
git commit -m "feat(mcp): bridge API Gateway events to Web Fetch Request/Response"
```

---

### Task 3: `invokeApiKeyHandler.ts` — synthetic-event dispatch + result mapping

**Files:**
- Create: `mkpdfs-backend/src/functions/mcp/invokeApiKeyHandler.ts`
- Test: `mkpdfs-backend/src/functions/mcp/invokeApiKeyHandler.test.ts`

**Interfaces:**
- Consumes: nothing from Task 2 (independent).
- Produces:
  - `type ApiKeyHandler = (event: any, context: any) => Promise<APIGatewayProxyResult>`
  - `invokeApiKeyHandler(handler: ApiKeyHandler, opts: { apiKey: string; body?: unknown; pathParameters?: Record<string, string> }): Promise<CallToolResult>`
  - Used directly by Task 4 (`tools.ts`), once per tool.

Note on typing: `handler` is typed `(event: any, context: any) => ...` rather than importing `Context` from `aws-lambda`. The `*ApiKey` handlers this plan imports in Task 4 are Middy-wrapped (`middyfy` in `src/libs/lambda.ts` types its `handler` param as `any`), so their exported `main` type doesn't line up precisely with a strict `(event: APIGatewayProxyEvent, context: Context) => ...` signature — `any` sidesteps a false-positive type mismatch without weakening anything we actually rely on (the synthetic event is hand-built here regardless).

- [ ] **Step 1: Write the failing test**

Create `mkpdfs-backend/src/functions/mcp/invokeApiKeyHandler.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/functions/mcp/invokeApiKeyHandler.test.ts`
Expected: FAIL — `Cannot find module './invokeApiKeyHandler'`

- [ ] **Step 3: Write the implementation**

Create `mkpdfs-backend/src/functions/mcp/invokeApiKeyHandler.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/functions/mcp/invokeApiKeyHandler.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/functions/mcp/invokeApiKeyHandler.ts src/functions/mcp/invokeApiKeyHandler.test.ts
git commit -m "feat(mcp): dispatch tool calls to existing *ApiKey handlers in-process"
```

---

### Task 4: `tools.ts` — register the 6 v1 tools

**Files:**
- Create: `mkpdfs-backend/src/functions/mcp/tools.ts`
- Test: `mkpdfs-backend/src/functions/mcp/tools.test.ts`

**Interfaces:**
- Consumes: `invokeApiKeyHandler` (Task 3) — `invokeApiKeyHandler(handler: ApiKeyHandler, opts: {apiKey, body?, pathParameters?}): Promise<CallToolResult>`.
- Produces: `registerTools(server: McpServer, apiKey: string): void` — used directly by Task 5 (`handler.ts`).

- [ ] **Step 1: Write the failing test**

Create `mkpdfs-backend/src/functions/mcp/tools.test.ts`:

```typescript
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
  it('registers exactly the 6 v1 tools', async () => {
    const { json } = await callViaFreshServer({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const names = json.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual([
      'delete_template',
      'generate_pdf',
      'get_template',
      'list_templates',
      'update_template',
      'upload_template',
    ]);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/functions/mcp/tools.test.ts`
Expected: FAIL — `Cannot find module './tools'`

- [ ] **Step 3: Write the implementation**

Create `mkpdfs-backend/src/functions/mcp/tools.ts`:

```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { invokeApiKeyHandler } from './invokeApiKeyHandler';
import { main as generatePdfApiKey } from '../pdf/generateApiKey/handler';
import { main as listTemplatesApiKey } from '../templates/listTemplatesApiKey/handler';
import { main as getTemplateApiKey } from '../templates/getTemplateApiKey/handler';
import { main as uploadTemplateApiKey } from '../templates/uploadTemplateApiKey/handler';
import { main as updateTemplateApiKey } from '../templates/updateTemplateApiKey/handler';
import { main as deleteTemplateApiKey } from '../templates/deleteTemplateApiKey/handler';

export function registerTools(server: McpServer, apiKey: string): void {
  server.registerTool(
    'generate_pdf',
    {
      description:
        'Generate a PDF from a template and data. Returns a download URL valid for 5 days.',
      inputSchema: {
        templateId: z.string().describe('The template ID to render'),
        data: z
          .unknown()
          .describe(
            'Template data: a single object (1 page) or an array of objects (1 page each, max 50)',
          ),
      },
    },
    async (args) =>
      invokeApiKeyHandler(generatePdfApiKey, {
        apiKey,
        body: { templateId: args.templateId, data: args.data },
      }),
  );

  server.registerTool(
    'list_templates',
    { description: 'List all templates owned by this account.' },
    async () => invokeApiKeyHandler(listTemplatesApiKey, { apiKey }),
  );

  server.registerTool(
    'get_template',
    {
      description: 'Get a single template by id, including its Handlebars source.',
      inputSchema: { templateId: z.string() },
    },
    async (args) =>
      invokeApiKeyHandler(getTemplateApiKey, {
        apiKey,
        pathParameters: { templateId: args.templateId },
      }),
  );

  server.registerTool(
    'upload_template',
    {
      description: 'Create a new template from Handlebars source.',
      inputSchema: {
        name: z.string(),
        content: z.string().describe('Handlebars template source, as plain text'),
        description: z.string().optional(),
      },
    },
    async (args) =>
      invokeApiKeyHandler(uploadTemplateApiKey, {
        apiKey,
        body: { name: args.name, content: args.content, description: args.description },
      }),
  );

  server.registerTool(
    'update_template',
    {
      description: "Replace an existing template's Handlebars source in place.",
      inputSchema: { templateId: z.string(), content: z.string() },
    },
    async (args) =>
      invokeApiKeyHandler(updateTemplateApiKey, {
        apiKey,
        pathParameters: { templateId: args.templateId },
        body: { content: args.content },
      }),
  );

  server.registerTool(
    'delete_template',
    {
      description: 'Delete a template permanently.',
      inputSchema: { templateId: z.string() },
    },
    async (args) =>
      invokeApiKeyHandler(deleteTemplateApiKey, {
        apiKey,
        pathParameters: { templateId: args.templateId },
      }),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/functions/mcp/tools.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/functions/mcp/tools.ts src/functions/mcp/tools.test.ts
git commit -m "feat(mcp): register generate_pdf + template CRUD as MCP tools"
```

---

### Task 5: `handler.ts` — the Lambda entry point

**Files:**
- Create: `mkpdfs-backend/src/functions/mcp/handler.ts`
- Test: `mkpdfs-backend/src/functions/mcp/handler.test.ts`

**Interfaces:**
- Consumes: `registerTools` (Task 4), `buildWebRequest`/`toApiGatewayResult` (Task 2).
- Produces: `export const main: (event: APIGatewayProxyEvent, context: Context) => Promise<APIGatewayProxyResult>` — the CDK entry point wired in Task 6.

- [ ] **Step 1: Write the failing test**

Create `mkpdfs-backend/src/functions/mcp/handler.test.ts`:

```typescript
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
```

Note: the `vi.mock` calls must be the first statements in the file, before the
`import { main } from './handler'` line, per vitest's hoisting rules — keep that ordering.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/functions/mcp/handler.test.ts`
Expected: FAIL — `Cannot find module './handler'`

- [ ] **Step 3: Write the implementation**

Create `mkpdfs-backend/src/functions/mcp/handler.ts`:

```typescript
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
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

  const server = new McpServer({ name: 'mkpdfs', version: '1.0.0' });
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
```

Note: unlike every other Lambda in this repo, `main` here is **not** wrapped with `middyfy` — there is no API Gateway-shaped request/response chain to run (the real auth/credits/subscription middleware chains run one level down, inside the wrapped `*ApiKey` handlers that `tools.ts` calls per tool). This file only does transport plumbing plus one cheap `x-api-key` presence/format guard so a keyless request fails fast without spinning up an `McpServer`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/functions/mcp/handler.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Run the full test suite to confirm nothing else broke**

Run: `npx vitest run`
Expected: all suites PASS, including the 4 new `src/functions/mcp/*.test.ts` files alongside the pre-existing ones.

- [ ] **Step 6: Commit**

```bash
git add src/functions/mcp/handler.ts src/functions/mcp/handler.test.ts
git commit -m "feat(mcp): wire the POST /v1/mcp Lambda entry point"
```

---

### Task 6: CDK wiring — `McpFn` + `POST /v1/mcp`

**Files:**
- Modify: `mkpdfs-backend/cdk/lib/stacks/api-stack.ts`

**Interfaces:**
- Consumes: `src/functions/mcp/handler.ts`'s `main` export (Task 5) as the Lambda entry (referenced by file path, not imported).

- [ ] **Step 1: Insert the `McpFn` block**

In `mkpdfs-backend/cdk/lib/stacks/api-stack.ts`, find this exact block (it's the end of the `generatePdfApiKey` section, immediately before the `JOBS` section comment):

```typescript
    generatePdfAsync.grantInvoke(generatePdfApiKey);
    addRoute('/v1/pdf/generate', 'POST', generatePdfApiKey, false);

    // =================================================================
    // JOBS (async PDF generation)
    // =================================================================
```

Replace it with:

```typescript
    generatePdfAsync.grantInvoke(generatePdfApiKey);
    addRoute('/v1/pdf/generate', 'POST', generatePdfApiKey, false);

    // =================================================================
    // MCP (API-key only) — thin adapter over the /v1/* routes above.
    // Can execute generatePdfApiKey's full render path plus all 5 template
    // *ApiKey handlers in-process (see src/functions/mcp/tools.ts), so it
    // needs their combined footprint: Chromium layer + the union of grants.
    // =================================================================
    const mcpFn = makeFn('McpFn', {
      entry: 'src/functions/mcp/handler.ts',
      timeoutSeconds: 30,
      memorySize: 4096,
      layers: [chromiumLayer],
    });
    grantDualAuth(mcpFn);
    grantSubscriptionMw(mcpFn);
    grantUsageTracking(mcpFn);
    bucket.grantRead(mcpFn);
    bucket.grantPut(mcpFn);
    bucket.grantDelete(mcpFn);
    tables.templates.grantReadWriteData(mcpFn);
    tables.marketplace.grantReadData(mcpFn);
    grantSes(mcpFn);
    tables.creditLedger.grantWriteData(mcpFn); // debit ledger entries (generate_pdf)
    grantSsmParams(mcpFn, env); // stripe-secret-key for auto-recharge
    mcpFn.addEnvironment(
      'GENERATE_PDF_ASYNC_FUNCTION_NAME',
      generatePdfAsync.functionName,
    );
    generatePdfAsync.grantInvoke(mcpFn);
    addRoute('/v1/mcp', 'POST', mcpFn, false);

    // =================================================================
    // JOBS (async PDF generation)
    // =================================================================
```

- [ ] **Step 2: Typecheck**

Run (from `mkpdfs-backend/`):
```bash
npm run typecheck
```
Expected: exits 0, no errors (this runs `tsc --noEmit` on both `src` and `cdk`).

- [ ] **Step 3: Synth the dev stack**

Run:
```bash
cd cdk && AWS_PROFILE=rocketeast cdk synth -c environment=dev > /dev/null && echo SYNTH_OK
```
Expected: `SYNTH_OK` (requires a valid `rocketeast` AWS SSO session — if it fails on credentials rather than a CDK/synth error, run `aws sso login --profile rocketeast` first and retry).

- [ ] **Step 4: Commit**

```bash
git add cdk/lib/stacks/api-stack.ts
git commit -m "feat(mcp): wire McpFn + POST /v1/mcp into ApiStack"
```

---

### Task 7: Deploy to dev + smoke test

**Files:** none (infra + manual verification only)

- [ ] **Step 1: Deploy to dev**

Run (from `mkpdfs-backend/`):
```bash
npm run cdk:deploy:dev
```
Expected: all 6 stacks deploy successfully, including a new `McpFn` in `Mkpdfs-Api-dev`.

- [ ] **Step 2: Get a dev API key**

If you don't already have one, mint one against dev (see root `CLAUDE.md` CLI docs for `mkp auth login` / `mkp tokens create`), or reuse an existing dev `tlfy_*` key. Export it:
```bash
export MKPDFS_DEV_API_KEY="tlfy_..."
```

- [ ] **Step 3: Smoke test — tools/list**

```bash
curl -s -X POST "https://dev.apis.mkpdfs.com/v1/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "x-api-key: $MKPDFS_DEV_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```
Expected: JSON body with `result.tools` containing exactly 6 entries: `generate_pdf`, `list_templates`, `get_template`, `upload_template`, `update_template`, `delete_template`.

Note: the `accept: application/json, text/event-stream` header is **required** — the MCP
Streamable HTTP transport rejects requests without it (406). Real MCP clients always send it;
this was caught during Task 5 (its test fixture initially omitted it too — fixed there and here
for consistency). The Step 4 401 check below does NOT need it: that guard runs before the
transport is ever built.

If instead you get `{"message":"Missing Authentication Token"}`, the API Gateway stage may still be serving a stale deployment snapshot (a documented gotcha in root `CLAUDE.md`) — run:
```bash
aws apigateway create-deployment --rest-api-id <dev-rest-api-id> --stage-name dev --profile rocketeast
```
and retry.

- [ ] **Step 4: Smoke test — missing key → 401**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://dev.apis.mkpdfs.com/v1/mcp" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```
Expected: `401`

- [ ] **Step 5: Smoke test — list_templates tool call**

```bash
curl -s -X POST "https://dev.apis.mkpdfs.com/v1/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "x-api-key: $MKPDFS_DEV_API_KEY" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_templates","arguments":{}}}'
```
Expected: JSON body where `result.content[0].text` parses to `{"templates": [...]}` (same shape `GET /v1/templates` already returns).

- [ ] **Step 6 (optional, richer manual check): MCP Inspector**

```bash
npx @modelcontextprotocol/inspector
```
Point it at `https://dev.apis.mkpdfs.com/v1/mcp` with header `x-api-key: $MKPDFS_DEV_API_KEY`, and walk through `generate_pdf` against a real dev template plus the remaining CRUD tools.

- [ ] **Step 7: Merge to `main` for prod**

Once dev is verified, follow the existing branch policy (root `CLAUDE.md` "Branch Strategy"): merge `dev` → `main` to deploy to prod via the existing CI pipeline. No manual prod steps beyond that — same CI path every other backend change already takes.

---

### Task 8: Docs

**Files:**
- Modify: `mkpdfs-backend/CLAUDE.md`
- Modify: `CLAUDE.md` (repo root — orchestrator repo, a **separate** git repository from `mkpdfs-backend`; commit this one separately)

- [ ] **Step 1: `mkpdfs-backend/CLAUDE.md`**

Find the end of the existing section (search for this exact closing line):

```
`tlfy_*` token; token scopes deferred.
```

Immediately after that line (and its blank line), insert a new subsection:

```markdown
#### MCP server — `POST /v1/mcp` (API-key only, added 2026-07-03)

Exposes `generate_pdf` + template CRUD (`list_templates`, `get_template`, `upload_template`,
`update_template`, `delete_template`) as [MCP](https://modelcontextprotocol.io) tools, so
external services/agents can drive mkpdfs the same way the CLI does headlessly. Same posture
as `/v1/pdf/generate` and `/v1/templates/*`: no Gateway authorizer, `x-api-key: tlfy_*` only.

Each tool call builds a synthetic `APIGatewayProxyEvent` and invokes the matching `*ApiKey`
handler's exported `main` **in-process** (`src/functions/mcp/tools.ts` +
`invokeApiKeyHandler.ts`) — no network hop, and auth/credits/subscription/usage-tracking stay
guaranteed-identical to REST because it's literally the same code running. `generate_pdf` is
synchronous only (no `async`/`sendEmail`).

Transport: `@modelcontextprotocol/sdk`'s `WebStandardStreamableHTTPServerTransport`
(`server/webStandardStreamableHttp.js` — pure Fetch API `Request`/`Response`, no Node `http`
shim), stateless (`sessionIdGenerator: undefined`) — a fresh `McpServer` + transport pair is
built **per Lambda invocation** (the SDK throws if a stateless transport is reused across
requests). `McpFn` shares `GeneratePdfApiKeyFn`'s footprint (Chromium layer, 4096 MB, 30s
timeout) since `generate_pdf` can take the same render path.
```

- [ ] **Step 2: root `CLAUDE.md`**

In the repo root (`/Users/sim4r4/sim4r4/repos/mkpdfs/CLAUDE.md`, **not** the `mkpdfs-backend` one), find this exact block in the `## API & Auth` section:

```markdown
- **`/v1/templates/*`** — headless template CRUD, **API-key ONLY** (no Gateway authorizer, `apiKeyOnlyMiddleware`; mirrors `/v1/pdf/generate`), added 2026-06-18 (#2): `GET /v1/templates`, `GET|PUT|DELETE /v1/templates/{templateId}`, `POST /v1/templates/upload`. Consumed by the CLI `mkp templates … --api-key`. Token mint/revoke stays JWT-only.
- Biggest consumer: Academia Connects service account `platform@academiaconnects.com` (enterprise, manual "Contact Sales" row). Provisioning is idempotent via `provision-mkpdfs.mjs` in the democonnect-api repo; its secrets live in SSM `/democonnect/labs/mkpdfs[-dev]/*` (SecureString — read with `--with-decryption`, never print).
```

Replace with:

```markdown
- **`/v1/templates/*`** — headless template CRUD, **API-key ONLY** (no Gateway authorizer, `apiKeyOnlyMiddleware`; mirrors `/v1/pdf/generate`), added 2026-06-18 (#2): `GET /v1/templates`, `GET|PUT|DELETE /v1/templates/{templateId}`, `POST /v1/templates/upload`. Consumed by the CLI `mkp templates … --api-key`. Token mint/revoke stays JWT-only.
- **`POST /v1/mcp`** — MCP (Model Context Protocol) server, **API-key ONLY** (mirrors `/v1/pdf/generate` and `/v1/templates/*`), added 2026-07-03. Exposes `generate_pdf` + template CRUD as MCP tools by invoking the same `*ApiKey` handlers in-process (synthetic API Gateway event, no network hop) — guarantees auth/credits/subscription parity with REST. Stateless Streamable HTTP transport (fresh `McpServer` + transport per invocation, no session state). Details: `mkpdfs-backend/CLAUDE.md`.
- Biggest consumer: Academia Connects service account `platform@academiaconnects.com` (enterprise, manual "Contact Sales" row). Provisioning is idempotent via `provision-mkpdfs.mjs` in the democonnect-api repo; its secrets live in SSM `/democonnect/labs/mkpdfs[-dev]/*` (SecureString — read with `--with-decryption`, never print).
```

- [ ] **Step 3: Commit each repo separately**

```bash
cd mkpdfs-backend
git add CLAUDE.md
git commit -m "docs: document the MCP server (POST /v1/mcp)"

cd ..
git add CLAUDE.md
git commit -m "docs: note the new /v1/mcp route in API & Auth"
```

This docs commit is separate from bumping the root repo's `mkpdfs-backend` submodule pointer —
that follows the existing convention already used for every other backend change (e.g. root
commit `c223c15 chore: bump submodules — backend /v1/templates (d21c3bd, prod) + cli v0.3.0
(48cc40e, --api-key)`): once Task 6's commits are pushed on `mkpdfs-backend`'s `dev` branch,
bump the pointer with its own `chore: bump mkpdfs-backend -> <short-sha> (mcp server)`-style
commit at the root. Not a new process — just apply the existing one.
