# Design — headless `/v1/templates/*` (API-key) + CLI `--api-key` for templates (#2)

**Date:** 2026-06-18
**Status:** Approved design (user delegated review to codex — No-Go → revised below)
**Repos:** `mkpdfs-backend` (routes) + `mkpdfs-cli` (consumer)
**Supersedes:** the stub `mkpdfs-cli/docs/superpowers/specs/2026-06-17-headless-templates-tokens-followup.md`

## Goal

Let CI pipelines manage **templates** headlessly with an API key (`x-api-key: tlfy_*`),
the same way `pdf generate` already works. Today every `templates` route is JWT-only
behind the Cognito Gateway authorizer (`iamOnlyMiddleware`, `allowApiToken:false`), so
a pipeline can't push/update templates without a human browser login.

## Scope (decided)

- **Templates CRUD only.** Token management is **out** — minting/revoking tokens via an
  API key is privilege escalation. `usage`/`profile`/`credits` stay JWT-only (not needed
  headless).
- **Tokens stay full-access** (no scopes). A `tlfy_*` token already grants full account
  access (it can generate PDFs); extending it to template CRUD is consistent. Scoped
  tokens are a documented future improvement, not in this work.
- **Backend + CLI in one spec** — the backend routes plus the CLI `--api-key` path, so
  the feature is usable end-to-end.

## Architecture

Mirror the existing `/v1/pdf/generate` precedent exactly: parallel `/v1/templates/*`
routes with **no API Gateway authorizer**, each a thin wrapper that imports the existing
JWT handler's *core* function and re-wraps it with `apiKeyOnlyMiddleware()` (which only
accepts `x-api-key: tlfy_*` and rejects `Authorization: Bearer` — see the security note).
The existing JWT routes are **untouched** (the web app keeps using them).

### Routes (5, all `cognitoAuth=false`)

| v1 route | reused core | middleware chain (v1) |
|---|---|---|
| `GET /v1/templates` | `listTemplates` | `apiKeyOnly` |
| `GET /v1/templates/{templateId}` | `getTemplate` | `apiKeyOnly` |
| `POST /v1/templates/upload` | `uploadTemplate` | `apiKeyOnly` + `subscription` + `usageTracking('template_upload')` |
| `PUT /v1/templates/{templateId}` | `updateTemplate` | `apiKeyOnly` + `subscription` |
| `DELETE /v1/templates/{templateId}` | `deleteTemplate` | `apiKeyOnly` |

Each v1 chain = the JWT handler's chain with `iamOnlyMiddleware()` swapped for
`apiKeyOnlyMiddleware()`; everything downstream is identical (both set `event.userId`).

Excluded (web-only, YAGNI): `POST /templates/logo-upload-url`,
`PATCH /templates/{templateId}/theme`.

## Backend components

1. **Export the cores (5 one-word refactors).** Template handlers currently define their
   core as a non-exported `const` and only `export const main = middyfy(core).use(...)`.
   Change `const listTemplates` → `export const listTemplates` (and the other four), so the
   wrappers can import them — exactly how `pdf/generate` exports `generatePdf`. `main` is
   unchanged, so the JWT routes are unaffected.

2. **5 wrapper handlers** at `src/functions/templates/{list,get,upload,update,delete}TemplateApiKey/handler.ts`,
   each:
   ```ts
   import { listTemplates } from '../listTemplates/handler';
   export const main = middyfy(listTemplates).use(apiKeyOnlyMiddleware());
   ```
   (upload/update add their `subscription`/`usageTracking` middleware to match the JWT chain.)

3. **CDK wiring** in `api-stack.ts`: 5 `makeFn` + `addRoute('/v1/templates...', method, fn, false)`.

   **⚠ IAM (codex blocker):** `apiKeyOnlyMiddleware` reads `TOKENS_TABLE` and updates
   `lastUsed` *before* the handler runs. The existing JWT template Lambdas do **not** have
   token grants (`iamOnly` validates nothing against the tokens table). So "same grants as
   the JWT version" is **insufficient** — each v1 fn must also get `grantDualAuth(fn)`
   (= `tables.tokens.grantReadWriteData`), exactly like `generatePdfApiKey` does. Full grant
   set per v1 fn (each = **the exact grants of its JWT sibling**, then ADD `grantDualAuth`):
   - all: `grantDualAuth` (tokens RW) — **the fix above**
   - list: `tables.templates.grantReadData`, `tables.marketplace.grantReadData`, `bucket.grantRead`
   - get: `tables.templates.grantReadData`, `bucket.grantRead`
   - upload: `tables.templates.grantReadWriteData`, `bucket.grantPut`, `grantSubscriptionMw`, `grantUsageTracking`
   - update: `tables.templates.grantReadWriteData`, `bucket.grantPut`, `grantSubscriptionMw`
   - delete: `tables.templates.grantReadWriteData`, `bucket.grantDelete`
   (Verified against the JWT siblings — note the **least-privilege bucket grants**:
   `grantPut` for upload/update, `grantDelete` for delete, not a blanket RW.)

4. **No special browser/CORS requirements** — these are server-to-server, like
   `/v1/pdf/generate`. (The RestApi has default CORS preflight configured globally, so this
   isn't a strict "no OPTIONS resource" assertion — just that v1 templates need no extra
   CORS work.)

### Payload & limits (codex)

- The CLI sends **JSON with base64-encoded content** (not multipart) — see
  `uploadTemplate`'s JSON branch. This avoids the fragile multipart parser entirely; CI
  must use the JSON path.
- API Gateway REST has a hard **10 MB request limit**; base64 inflates ~33%, so the
  effective template ceiling is ~7 MB of source. The CLI must enforce a **client-side size
  cap of ~6.5 MiB** (a concrete constant, kept under the ~7 MB ceiling to leave room for
  JSON overhead) with a clear error before sending. (No authorizer doesn't change this.)
- `binaryMediaTypes` is **not** configured (fine for text Handlebars). Do not enable
  multipart for CI unless the parser is hardened — out of scope here.

### Route-collision note

`/v1/templates/upload` (static) coexists with `/v1/templates/{templateId}` — safe because
template IDs are UUIDs, so a `templateId` literally equal to `upload` can't occur (the risk
is the *id*, not the template's display name). Same pattern the JWT routes already use.

## CLI components (`mkpdfs-cli`)

The CLI gets `--api-key` on the templates commands. This is **not** a simple base-URL
swap (codex):

- **Client:** add `GetWithKey` / `PutWithKey` / `DeleteWithKey` to `internal/api/client.go`
  (only `PostWithKey` exists). Add an `apiKeyClient()` helper (mirrors `jwtClient()`) using
  `WithAPIKey()`. When `--api-key` is set, target `/v1/templates/*` and send `x-api-key`.
- **`list` / `get` / `pull` / `delete`:** straightforward — route to the v1 path with the key.
- **`push` (the nuanced one):**
  - `templates push` always builds a JWT client today, and its drift/conflict check
    fetches via JWT (`fetchTemplate`). Under `--api-key`, drift detection must fetch via
    `GET /v1/templates/{id}` with the key.
  - The **env guard** (`.mkpdfs.json` bound to an env) is preserved.
  - The **account guard** (`push_logic.go` compares `map.UserID` to the caller) can't work
    under API-key mode — there's no JWT to read the caller's `userId` from. Resolution:
    in `--api-key` mode, **skip the account guard** (ownership is enforced server-side by
    the token's `userId`; a key can only touch its own account anyway) but **keep the env
    guard and the remote-`updatedAt` drift check**. Document this clearly.
- **Idempotency — enforced, not just documented (codex):** `upload` always creates a new
  UUID, so a retried CI *create* duplicates the template. To make CI safe by default,
  `push --api-key` **requires** an existing `.mkpdfs.json` entry for the file (or an explicit
  `--id`) so the push resolves to a `PUT`; creating a brand-new template headless requires an
  explicit **`--new`** flag. This preserves today's interactive behavior (where a first push
  creates) while preventing silent duplicates on CI retries. The remote-`updatedAt` drift
  check is preserved under `--api-key`. **Do not** emulate API-key mode by passing `--force`
  — `--force` also skips the drift check, which we want to keep.
- **README:** broaden the CI section — templates are no longer browser-only; show a CI
  `push`/`pull` example with `MKPDFS_API_KEY`. (Tokens/usage/credits remain JWT-only.)

## Security

- `apiKeyOnlyMiddleware` rejects `Authorization: Bearer` deliberately: on an authorizer-less
  route, `dualAuth`'s unsigned `decode()` would let anyone forge a `sub` and impersonate.
  Only `x-api-key` validated via SHA256 against `TOKENS_TABLE`.
- Ownership is enforced server-side by the token's `userId` (identical to the JWT path —
  the handlers key all reads/writes off `event.userId`).
- Tokens remain full-access; scopes deferred.

## Out of scope / noted

- **Token scopes** (e.g. a `templates:write`-only CI token) — future improvement.
- **Pre-existing bug (not fixed here):** `usageTrackingMiddleware` only counts
  `statusCode === 200`, but `uploadTemplate` returns `201`, so template-upload usage is
  never tracked — on both the JWT and the new v1 route. Flag it; fixing it is separate.
- **Subscription 402:** `subscriptionMiddleware` can return non-200 if the subscription
  status is inactive — this is unrelated to credits (template routes have no credit gate),
  but CI should expect a clear error if the account is suspended.

## Testing

- **Backend** (no handler unit tests exist today): validate against dev via `curl` with a
  real API key — valid key, **invalid key → 401**, **Bearer-only → 401** (forged-JWT
  rejection), and the full CRUD cycle (create → list → get → update → delete). Pre-create
  the new Lambda log groups if the monitoring stack requires it (per the CDK runbook).
- **CLI:** unit tests for the `--api-key` routing (fake client, like `credits_test.go`):
  correct `/v1/...` path + `x-api-key` header per command; `push --api-key` drift fetch via
  v1; account-guard skipped but env-guard + drift preserved; client-side size-cap error;
  **`push --api-key` with no map entry and no `--new` → usage error (exit 2)**, and with
  `--new` → create path.
- **Smoke:** add a headless block to `scripts/smoke.sh` — `MKPDFS_API_KEY=... mkp templates
  push/pull/delete --api-key` against dev.

## Rollout

Backend deploys to dev first (push to `dev`), verified with `curl`, then the CLI `--api-key`
path is validated end-to-end against dev before merging to `main`. CLI release via the
existing labeled-PR flow (now self-serving after the inline-GoReleaser fix).
