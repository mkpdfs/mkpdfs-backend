# Design — MCP server (`POST /v1/mcp`)

**Date:** 2026-07-03
**Status:** Approved design
**Repos:** `mkpdfs-backend` only
**Builds on:** the headless API-key surface from
`2026-06-18-v1-templates-headless-design.md` (`/v1/pdf/generate`, `/v1/templates/*`)

## Goal

Let external services and AI agents (a customer's own Claude/agent, or ours) drive mkpdfs
— generate PDFs, manage templates — over the [Model Context Protocol](https://modelcontextprotocol.io)
instead of hand-rolled REST calls, using the same `x-api-key: tlfy_*` credential the CLI and
`/v1/*` routes already accept. This is the MCP-shaped version of the existing headless
surface, not a new product surface with its own rules.

## Scope (decided)

- **Tools = existing `/v1/*` core.** `generate_pdf` + template CRUD (`list_templates`,
  `get_template`, `upload_template`, `update_template`, `delete_template`). No new business
  logic — every tool is a thin adapter over a route that already exists and is already
  proven (auth, credits, subscription limits, usage tracking).
- **Out for v1:** marketplace tools, async jobs (`/jobs/submit` has the known Cognito-authorizer
  bug — see root `CLAUDE.md` backlog — and MCP tool calls are expected to be a single
  request/response, not poll-driven), credit-balance introspection (no existing API-key
  route to reuse; would be new surface, not adapter work). All can be added later as their
  own thin tools once there's a route to wrap.
- **`generate_pdf` is synchronous only.** The REST route's `async: true` branch (fire-and-email)
  and `sendEmail` are not exposed as tool params — an MCP tool call is expected to return in
  one round trip.
- **API-key only**, exactly like `/v1/pdf/generate` and `/v1/templates/*`: no Cognito
  Gateway authorizer, `Authorization: Bearer` rejected in-lambda. Same reasoning as the
  prior spec's Security section — without the authorizer, accepting an unsigned/forged JWT
  would let anyone impersonate.

## Architecture

### Route & transport

One new Lambda, `POST /v1/mcp`, wired into the existing `ApiStack` (no new stack — it's one
function, same lifecycle as the other `/v1/*` routes). Uses `@modelcontextprotocol/sdk`
(new dependency, confirmed on npm at `1.29.0`) with `WebStandardStreamableHTTPServerTransport`
(`@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`) in **stateless mode**
(`sessionIdGenerator: undefined`, `enableJsonResponse: true`): every Lambda invocation is one
self-contained JSON-RPC request in, one JSON-RPC response out — no server-initiated push, no
SSE stream held open across invocations, which matches how Lambda actually runs (no shared
memory between invocations to anchor a long-lived MCP session against).

**Verified against the real SDK (not guessed):** the "Web Standard" transport variant operates
purely on Fetch API `Request`/`Response` objects (`handleRequest(req: Request): Promise<Response>`),
which Node 20 (the Lambda runtime already in use) provides as globals — no
`http.IncomingMessage`/`ServerResponse` shim needed at all, which resolves what an earlier draft
of this spec flagged as the main technical risk. Confirmed by a local probe (installed the real
package, wired `McpServer` + this transport, sent live `initialize`/`tools/list`/`tools/call`
JSON-RPC requests through it): a **fresh `McpServer` + fresh transport instance must be created
per invocation** ("Stateless transport cannot be reused across requests" is a thrown error
otherwise) — but a brand-new transport handles `tools/list`/`tools/call` correctly without a
prior `initialize` having been sent to that same instance, so "one Lambda invocation = one new
server+transport pair, handles exactly one request" is sufficient; no session bootstrapping
across invocations is required. Zod-schema validation errors on tool args are handled by the
SDK automatically (surfaced as `isError: true` results), not something this project's code needs
to implement.

### Auth

Same `apiKeyOnlyMiddleware` used by every other `/v1/*` route — reused as-is (see "Tool
dispatch", below — it fires per tool call, not once per connection, because MCP has no
persistent connection here).

### Tool dispatch: in-process invocation of the existing `main` handlers

The key design decision, and the reason this stays thin: each tool does **not** call
`pdfService`/`templates` service code directly (that would mean re-implementing the
subscription/credit/usage-tracking Middy chain by hand — real logic worth not duplicating).
Instead, each tool handler:

1. Builds a synthetic `APIGatewayProxyEvent` — `headers: { 'x-api-key': <key from the MCP
   request>, 'content-type': 'application/json' }`, `body: JSON.stringify(toolArgs)`,
   `pathParameters` set for path-param routes (e.g. `{ templateId }`), `isBase64Encoded: false`.
2. Imports and calls the already-exported `main` from the matching `*ApiKey/handler.ts` file
   (e.g. `import { main as generatePdfApiKey } from '../pdf/generateApiKey/handler'`) directly
   as a function — `await generatePdfApiKey(fakeEvent, fakeContext)`. Middy v6 is async/promise
   native (`src/libs/lambda.ts`), so this needs no callback shimming.
3. Maps the returned `APIGatewayProxyResult` (`{ statusCode, body }`) to an MCP `CallToolResult`
   (see "Error mapping", below).

This is a real Lambda-to-Lambda-handler call *within the same Lambda process* — not a network
hop, not a second `Invoke`. It gets us, for free and guaranteed-in-sync with REST: the exact
same auth check, the exact same 402 credit gate, the exact same subscription limits, the exact
same usage-tracking and credit-debit side effects. If those REST routes change, the MCP tools
change with them automatically — nothing to keep in sync by hand.

**Consequence for the CDK function config:** because `McpFn` can execute the full body of
`generatePdfApiKey` (Puppeteer/Chromium render) as well as all 5 template handlers, it needs
their **combined** footprint, not a lighter one:
- `layers: [chromiumLayer]`, `memorySize: 4096`, `timeoutSeconds: 30` (matches
  `GeneratePdfApiKeyFn` exactly — rendering is the heaviest path it can take).
- IAM: the union of `generatePdfApiKey`'s grants (`grantDualAuth`, `grantSubscriptionMw`,
  `grantUsageTracking`, `bucket.grantRead`, `bucket.grantPut`, `tables.templates.grantReadData`,
  `grantSes`, `tables.creditLedger.grantWriteData`, `grantSsmParams`, invoke on
  `generatePdfAsync` — even though the tool never sets `async: true`, the fake event still
  flows through the same handler code path, which references
  `GENERATE_PDF_ASYNC_FUNCTION_NAME`/`SES` at module scope) **plus** the 5 template handlers'
  grants (`tables.templates.grantReadWriteData`, `tables.marketplace.grantReadData`,
  `bucket.grantDelete`).

## Tools (v1)

| MCP tool | args (zod) | wraps (`main` import) | notes |
|---|---|---|---|
| `generate_pdf` | `templateId: string`, `data: unknown` | `pdf/generateApiKey` | `data` may be a single object or array (1 page each, ≤50 — enforced by the wrapped handler, not re-validated here) |
| `list_templates` | *(none)* | `templates/listTemplatesApiKey` | |
| `get_template` | `templateId: string` | `templates/getTemplateApiKey` | |
| `upload_template` | `name: string`, `content: string`, `description?: string` | `templates/uploadTemplateApiKey` | `content` is sent as plain Handlebars text (no `contentEncoding: 'base64'` field — that's opt-in on the wrapped handler, only needed for binary-unsafe transports like the CLI; MCP tool args are already a JSON string field, so plain text round-trips fine); synthetic event forces the JSON branch (`content-type: application/json`), never the multipart branch |
| `update_template` | `templateId: string`, `content: string` | `templates/updateTemplateApiKey` | same plain-text `content` handling as `upload_template` |
| `delete_template` | `templateId: string` | `templates/deleteTemplateApiKey` | |

Tool result on success: a single `text` content block containing the wrapped handler's
response body as-is (already-shaped JSON — `{ success, pdfUrl, expiresIn, size,
pagesGenerated }` for `generate_pdf`, `{ templates: [...] }` for `list_templates`, etc.) —
no reshaping, so the MCP surface's response shape is guaranteed identical to the REST
surface's.

## Error mapping

The wrapped handler's `APIGatewayProxyResult.statusCode` drives the MCP result:

- `200`/`201` → normal `CallToolResult` (`isError` absent), `content` = the body text.
- Anything else (`400`, `401`, `402 INSUFFICIENT_CREDITS`, `403`, `404`, `5xx`) →
  `CallToolResult` with `isError: true` and `content` = the body text (already
  human/LLM-readable JSON, e.g. `{ error: 'INSUFFICIENT_CREDITS', ... }`) — this is a *tool*
  error, not a JSON-RPC protocol error, so the calling agent's model sees it in the
  conversation and can react (tell its user to top up credits, fix a bad template id, etc.)
  rather than the call just failing opaquely.
- A missing/invalid `x-api-key` fails inside `apiKeyOnlyMiddleware` before the core handler
  runs, same 401 shape as REST today — mapped the same way (`isError: true`).

## Backend components

1. **New dependency:** `@modelcontextprotocol/sdk` (not currently installed — confirmed via
   `npm ls`).
2. **New Lambda:** `src/functions/mcp/handler.ts` — sets up the `McpServer`, registers the 6
   tools (dispatch logic above), wires the transport/API-Gateway shim, exports `main`.
   No Middy chain of its own — `apiKeyOnlyMiddleware` runs once per *tool call* inside the
   dispatch step (step 2 above), not once per Lambda invocation, since a single MCP request
   could in principle be a batch — v1 keeps it to one tool call per JSON-RPC request, matching
   normal MCP client behavior.
3. **CDK wiring** in `api-stack.ts`: one `makeFn('McpFn', { entry: 'src/functions/mcp/handler.ts',
   timeoutSeconds: 30, memorySize: 4096, layers: [chromiumLayer] })` + the combined grants
   listed above + `addRoute('/v1/mcp', 'POST', mcpFn, false)`.
4. **Monitoring stack does not need changes.** Checked `monitoring-stack.ts`: its log-based
   metric filters key off an explicit `billingFns` props object (`stripeWebhook`, `generatePdf`,
   `generatePdfApiKey`, `processJob`) rather than scanning every Lambda, and `McpFn` isn't part
   of that set. The root `CLAUDE.md` "pre-create the log group" gotcha only bites a function
   that IS added to that set before its first invocation — doesn't apply here since this spec
   doesn't add `McpFn` billing/error alarms (out of scope, see below).

## Security

- Same posture as the rest of `/v1/*`: no Gateway authorizer, `apiKeyOnlyMiddleware` rejects
  `Authorization: Bearer` (forged-JWT-impersonation guard), ownership enforced server-side by
  the token's `userId` — identical to REST because it's *literally* the REST handler running.
- No new privilege surface: an MCP tool call can do exactly what the equivalent `curl` with
  the same `tlfy_` key could already do. Token scopes remain deferred (same note as the prior
  spec).

## Out of scope / noted

- Marketplace tools, async job tools, credit-balance tool — see Scope.
- Public docs (`mkpdfs-web` `/docs` page walking a customer through adding
  `https://apis.mkpdfs.com/v1/mcp` to their agent) — natural follow-up, separate piece of work.
- `GET`/`DELETE` on `/v1/mcp` (session resumption / termination, part of the full Streamable
  HTTP spec) are not wired — stateless mode has no session to resume or terminate. A client
  that probes those gets API Gateway's default "Missing Authentication Token" rather than a
  clean 405; acceptable for v1, revisit if a client library insists on probing them.

## Testing

- **Unit tests for the new adapter code** (unlike the `*ApiKey` handlers, this is new glue code
  worth covering directly): the event↔Request/Response mapping, the synthetic-event dispatch +
  status→`CallToolResult` mapping, and tool registration (all 6 tools reachable via a real
  `McpServer` + `WebStandardStreamableHTTPServerTransport` pair, with only the wrapped
  `*ApiKey` handlers mocked so no AWS calls are made). The wrapped handlers themselves stay
  unverified by unit tests, same as today (no regression — REST already only has manual
  coverage there).
- **Manual smoke against dev**: **MCP Inspector CLI** (`npx @modelcontextprotocol/inspector`)
  pointed at `dev.apis.mkpdfs.com/v1/mcp` with a real dev `tlfy_` key — `tools/list`, then each
  of the 6 tools once (including a deliberate bad `templateId` to confirm the 404 maps to
  `isError: true`, and — if feasible — draining a test account's credits to confirm the 402
  path). Also confirm the auth guard: missing key → 401 before an `McpServer` is even built;
  `Authorization: Bearer <jwt>` alone (no `x-api-key`) → same 401 (no forged-JWT path here,
  since the top-level key check never looks at `Authorization`).

## Rollout

Deploys to dev first (push to `dev`), verified with MCP Inspector, then to prod after dev
verification — same branch policy as everything else (root `CLAUDE.md` "Branch Strategy").
