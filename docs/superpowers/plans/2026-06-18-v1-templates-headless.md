# Headless `/v1/templates/*` + CLI `--api-key` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let CI pipelines manage templates headlessly with an API key by adding authorizer-less `/v1/templates/*` routes and a CLI `--api-key` path.

**Architecture:** Mirror the existing `/v1/pdf/generate` precedent — thin wrapper Lambdas reuse the JWT handlers' core functions wrapped with `apiKeyOnlyMiddleware` (no API Gateway authorizer). The CLI gets `--api-key` on templates commands that target `/v1/templates/*` and send `x-api-key`. JWT routes are untouched.

**Tech Stack:** AWS CDK + TypeScript (middy) backend; Go + Cobra CLI.

**Spec:** `mkpdfs-backend/docs/superpowers/specs/2026-06-18-v1-templates-headless-design.md`

## Global Constraints

- Spans **two repos**: `mkpdfs-backend` (Tasks 1–2, branch `feat/v1-templates-headless`) and `mkpdfs-cli` (Tasks 3–6, branch `feat/templates-api-key`). Each task names its repo.
- Templates CRUD only. NO token management headless. Tokens stay full-access (no scopes).
- `apiKeyOnlyMiddleware` rejects `Authorization: Bearer` deliberately (forged-JWT defense on authorizer-less routes). Only `x-api-key: tlfy_*`.
- Each v1 Lambda gets the **exact IAM grants of its JWT sibling PLUS `grantDualAuth`** (tokens RW — required by apiKeyOnlyMiddleware's `lastUsed` update). Least-privilege bucket grants: `grantPut` (upload/update), `grantDelete` (delete), `grantRead` (list/get).
- CLI CI path uses **JSON base64** content (never multipart). Client-side size cap **6.5 MiB**.
- `push --api-key` requires an existing `.mkpdfs.json` entry or `--id`; creating new headless requires `--new`. Account guard skipped in api-key mode; env guard + remote-`updatedAt` drift check preserved.
- Backend has no handler unit-test harness — backend tasks verify via `npm run typecheck`, `cdk diff`, and `curl` against dev.

---

### Task 1: Export template cores + create API-key wrapper handlers

**Repo:** `mkpdfs-backend` (branch `feat/v1-templates-headless`)

**Files:**
- Modify: `src/functions/templates/listTemplates/handler.ts` (export core)
- Modify: `src/functions/templates/getTemplate/handler.ts` (export core)
- Modify: `src/functions/templates/uploadTemplate/handler.ts` (export core)
- Modify: `src/functions/templates/updateTemplate/handler.ts` (export core)
- Modify: `src/functions/templates/deleteTemplate/handler.ts` (export core)
- Create: `src/functions/templates/listTemplatesApiKey/handler.ts`
- Create: `src/functions/templates/getTemplateApiKey/handler.ts`
- Create: `src/functions/templates/uploadTemplateApiKey/handler.ts`
- Create: `src/functions/templates/updateTemplateApiKey/handler.ts`
- Create: `src/functions/templates/deleteTemplateApiKey/handler.ts`

**Interfaces:**
- Produces: named exports `listTemplates`, `getTemplate`, `uploadTemplate`, `updateTemplate`, `deleteTemplate` (the core handler functions, unwrapped). Each wrapper's `export const main = middyfy(<core>).use(apiKeyOnlyMiddleware())…`.

- [ ] **Step 1: Export the five core functions**

In each of the five JWT handlers, add `export` to the core `const` declaration. Exact edits:

`listTemplates/handler.ts:14` — `const listTemplates:` → `export const listTemplates:`
`getTemplate/handler.ts:12` — `const getTemplate:` → `export const getTemplate:`
`uploadTemplate/handler.ts:23` — `const uploadTemplate:` → `export const uploadTemplate:`
`updateTemplate/handler.ts:20` — `const updateTemplate:` → `export const updateTemplate:`
`deleteTemplate/handler.ts:12` — `const deleteTemplate:` → `export const deleteTemplate:`

Do NOT touch the `export const main = …` lines.

- [ ] **Step 2: Create the list wrapper**

`src/functions/templates/listTemplatesApiKey/handler.ts`:

```ts
import { middyfy } from '@libs/lambda';
import { apiKeyOnlyMiddleware } from '@libs/middleware/dualAuth';
import { listTemplates } from '../listTemplates/handler';

// GET /v1/templates — server-to-server (x-api-key). Reuses the JWT core; auth is
// in-lambda via apiKeyOnlyMiddleware (Bearer rejected — see dualAuth.ts).
export const main = middyfy(listTemplates).use(apiKeyOnlyMiddleware());
```

- [ ] **Step 3: Create the get wrapper**

`src/functions/templates/getTemplateApiKey/handler.ts`:

```ts
import { middyfy } from '@libs/lambda';
import { apiKeyOnlyMiddleware } from '@libs/middleware/dualAuth';
import { getTemplate } from '../getTemplate/handler';

// GET /v1/templates/{templateId} — server-to-server (x-api-key).
export const main = middyfy(getTemplate).use(apiKeyOnlyMiddleware());
```

- [ ] **Step 4: Create the upload wrapper (matches JWT chain)**

`src/functions/templates/uploadTemplateApiKey/handler.ts`:

```ts
import { middyfy } from '@libs/lambda';
import { apiKeyOnlyMiddleware } from '@libs/middleware/dualAuth';
import { subscriptionMiddleware } from '@libs/middleware/subscription';
import { usageTrackingMiddleware } from '@libs/middleware/usageTracking';
import { uploadTemplate } from '../uploadTemplate/handler';

// POST /v1/templates/upload — server-to-server (x-api-key). Same middleware chain
// as the JWT route, with apiKeyOnly swapped for iamOnly.
export const main = middyfy(uploadTemplate)
  .use(apiKeyOnlyMiddleware())
  .use(subscriptionMiddleware())
  .use(usageTrackingMiddleware({ actionType: 'template_upload' }));
```

- [ ] **Step 5: Create the update wrapper**

`src/functions/templates/updateTemplateApiKey/handler.ts`:

```ts
import { middyfy } from '@libs/lambda';
import { apiKeyOnlyMiddleware } from '@libs/middleware/dualAuth';
import { subscriptionMiddleware } from '@libs/middleware/subscription';
import { updateTemplate } from '../updateTemplate/handler';

// PUT /v1/templates/{templateId} — server-to-server (x-api-key).
export const main = middyfy(updateTemplate)
  .use(apiKeyOnlyMiddleware())
  .use(subscriptionMiddleware());
```

- [ ] **Step 6: Create the delete wrapper**

`src/functions/templates/deleteTemplateApiKey/handler.ts`:

```ts
import { middyfy } from '@libs/lambda';
import { apiKeyOnlyMiddleware } from '@libs/middleware/dualAuth';
import { deleteTemplate } from '../deleteTemplate/handler';

// DELETE /v1/templates/{templateId} — server-to-server (x-api-key).
export const main = middyfy(deleteTemplate).use(apiKeyOnlyMiddleware());
```

- [ ] **Step 7: Typecheck**

Run: `cd mkpdfs-backend && npm run typecheck`
Expected: PASS (no errors). If an import path is wrong it fails here.

- [ ] **Step 8: Commit**

```bash
cd mkpdfs-backend
git add src/functions/templates
git commit -m "feat(templates): export cores + add /v1 api-key wrapper handlers"
```

---

### Task 2: Wire `/v1/templates/*` routes in CDK + deploy + verify

**Repo:** `mkpdfs-backend` (branch `feat/v1-templates-headless`)

**Files:**
- Modify: `cdk/lib/stacks/api-stack.ts` (add 5 fns + routes after the templates block, ~line 282)

**Interfaces:**
- Consumes: the 5 wrapper `main` exports from Task 1; helpers `makeFn`, `addRoute`, `grantDualAuth`, `grantSubscriptionMw`, `grantUsageTracking` already in `api-stack.ts`.

- [ ] **Step 1: Add the 5 functions + routes**

In `cdk/lib/stacks/api-stack.ts`, immediately after the existing `deleteTemplate` route (`addRoute('/templates/{templateId}', 'DELETE', deleteTemplate, true);`), insert:

```ts
    // =================================================================
    // TEMPLATES v1 — server-to-server (x-api-key, NO gateway authorizer)
    // Reuse the JWT handler cores; each fn = JWT sibling's grants + grantDualAuth
    // (apiKeyOnlyMiddleware reads/updates TOKENS_TABLE before the handler runs).
    // =================================================================
    const listTemplatesApiKey = makeFn('ListTemplatesApiKeyFn', {
      entry: 'src/functions/templates/listTemplatesApiKey/handler.ts',
    });
    grantDualAuth(listTemplatesApiKey);
    tables.templates.grantReadData(listTemplatesApiKey);
    tables.marketplace.grantReadData(listTemplatesApiKey);
    bucket.grantRead(listTemplatesApiKey);
    addRoute('/v1/templates', 'GET', listTemplatesApiKey, false);

    const getTemplateApiKey = makeFn('GetTemplateApiKeyFn', {
      entry: 'src/functions/templates/getTemplateApiKey/handler.ts',
    });
    grantDualAuth(getTemplateApiKey);
    tables.templates.grantReadData(getTemplateApiKey);
    bucket.grantRead(getTemplateApiKey);
    addRoute('/v1/templates/{templateId}', 'GET', getTemplateApiKey, false);

    const uploadTemplateApiKey = makeFn('UploadTemplateApiKeyFn', {
      entry: 'src/functions/templates/uploadTemplateApiKey/handler.ts',
    });
    grantDualAuth(uploadTemplateApiKey);
    tables.templates.grantReadWriteData(uploadTemplateApiKey);
    bucket.grantPut(uploadTemplateApiKey);
    grantSubscriptionMw(uploadTemplateApiKey);
    grantUsageTracking(uploadTemplateApiKey);
    addRoute('/v1/templates/upload', 'POST', uploadTemplateApiKey, false);

    const updateTemplateApiKey = makeFn('UpdateTemplateApiKeyFn', {
      entry: 'src/functions/templates/updateTemplateApiKey/handler.ts',
    });
    grantDualAuth(updateTemplateApiKey);
    tables.templates.grantReadWriteData(updateTemplateApiKey);
    bucket.grantPut(updateTemplateApiKey);
    grantSubscriptionMw(updateTemplateApiKey);
    addRoute('/v1/templates/{templateId}', 'PUT', updateTemplateApiKey, false);

    const deleteTemplateApiKey = makeFn('DeleteTemplateApiKeyFn', {
      entry: 'src/functions/templates/deleteTemplateApiKey/handler.ts',
    });
    grantDualAuth(deleteTemplateApiKey);
    tables.templates.grantReadWriteData(deleteTemplateApiKey);
    bucket.grantDelete(deleteTemplateApiKey);
    addRoute('/v1/templates/{templateId}', 'DELETE', deleteTemplateApiKey, false);
```

- [ ] **Step 2: Typecheck + synth diff**

Run: `cd mkpdfs-backend && npm run typecheck && npm run cdk:diff`
Expected: typecheck PASS; the diff lists 5 new Lambda functions and 5 new API Gateway methods under `/v1/templates*` with NO authorizer. No changes to existing template routes.

- [ ] **Step 3: Deploy to dev**

Run: `cd mkpdfs-backend && npm run cdk:deploy:dev`
Expected: deploy succeeds. (If the monitoring stack requires pre-existing log groups for new fns, create `/aws/lambda/<FnName>` first per `docs/cdk-migration-plan.md` — only if the deploy rolls back complaining about a missing log group.)

- [ ] **Step 4: Verify with curl (needs a dev API key)**

Create a dev API key first (from a logged-in CLI): `mkp tokens create --name ci-test --env dev` and export it as `KEY=tlfy_…`. Then:

```bash
BASE=https://dev.apis.mkpdfs.com
# Bearer must be REJECTED (forged-JWT defense) → 401
curl -s -o /dev/null -w '%{http_code}\n' -X GET "$BASE/v1/templates" -H "Authorization: Bearer anything"   # expect 401
# Missing key → 401
curl -s -o /dev/null -w '%{http_code}\n' -X GET "$BASE/v1/templates"                                        # expect 401
# Valid key → 200 list
curl -s -X GET "$BASE/v1/templates" -H "x-api-key: $KEY" | head -c 300; echo
# Create
curl -s -X POST "$BASE/v1/templates/upload" -H "x-api-key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"name\":\"ci-smoke\",\"content\":\"$(printf '<h1>{{t}}</h1>' | base64)\",\"contentEncoding\":\"base64\"}"
# → capture templateId, then GET / PUT / DELETE /v1/templates/<id> with the key (each 200, delete prunes)
```
Expected: 401 for Bearer and missing-key; 200 for valid-key list/get/update/delete; 201 for create.

- [ ] **Step 5: Commit**

```bash
cd mkpdfs-backend
git add cdk/lib/stacks/api-stack.ts
git commit -m "feat(api): add headless /v1/templates/* routes (api-key, no authorizer)"
```

---

### Task 3: CLI client auto-attaches `x-api-key`

**Repo:** `mkpdfs-cli` (branch `feat/templates-api-key` — create from up-to-date `main`)

**Files:**
- Modify: `internal/api/client.go` (attach `x-api-key` in `do()` when apiKey set)
- Test: `internal/api/client_test.go`

**Interfaces:**
- Produces: any `*api.Client` built via `WithAPIKey()` sends `x-api-key` on ALL verbs (Get/Put/Delete/Post), so callers no longer need `PostWithKey` specifically.

- [ ] **Step 1: Create the branch**

```bash
cd mkpdfs-cli && git checkout main && git pull --ff-only && git checkout -b feat/templates-api-key
```

- [ ] **Step 2: Write the failing test**

Add to `internal/api/client_test.go`:

```go
func TestRequestAttachesApiKey(t *testing.T) {
	var gotKey, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.Header.Get("x-api-key")
		gotAuth = r.Header.Get("Authorization")
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	c := &Client{BaseURL: srv.URL, apiKey: "tlfy_abc"}
	if _, err := c.do("GET", "/x", nil, nil); err != nil {
		t.Fatal(err)
	}
	if gotKey != "tlfy_abc" {
		t.Fatalf("x-api-key = %q, want tlfy_abc", gotKey)
	}
	if gotAuth != "" {
		t.Fatalf("Authorization should be empty in api-key mode, got %q", gotAuth)
	}
}
```

- [ ] **Step 3: Run it — verify it fails**

Run: `cd mkpdfs-cli && go test ./internal/api/ -run TestRequestAttachesApiKey -v`
Expected: FAIL (`x-api-key = ""`).

- [ ] **Step 4: Implement — attach the key in `do()`**

In `internal/api/client.go`, in `do()`, right after the Bearer block:

```go
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	if c.apiKey != "" {
		req.Header.Set("x-api-key", c.apiKey)
	}
```

- [ ] **Step 5: Run tests — verify pass**

Run: `cd mkpdfs-cli && go test ./internal/api/ -v`
Expected: PASS (new test + existing `TestRequestAttachesBearer` still green).

- [ ] **Step 6: Commit**

```bash
cd mkpdfs-cli
git add internal/api/client.go internal/api/client_test.go
git commit -m "feat(api): auto-attach x-api-key on all verbs when key is set"
```

---

### Task 4: `decidePush` API-key mode (idempotency + skip account guard)

**Repo:** `mkpdfs-cli` (branch `feat/templates-api-key`)

**Files:**
- Modify: `internal/cli/push_logic.go`
- Test: `internal/cli/push_logic_test.go`

**Interfaces:**
- Consumes: existing `pushInput`, `decidePush`, `pushCreate`/`pushUpdate`, `ErrUsage`.
- Produces: `pushInput` gains `APIKeyMode bool`. Behavior: in API-key mode, an unknown file with neither `--new` nor `--id` is a usage error; the account guard (`Map.UserID` compare) is skipped.

- [ ] **Step 1: Write the failing tests**

Add to `internal/cli/push_logic_test.go`:

```go
func TestAPIKeyModeUnknownRequiresNewOrID(t *testing.T) {
	// unknown file, no --new, no --id, api-key mode → usage error
	_, err := decidePush(pushInput{File: "invoice.hbs", Map: entryMap("dev", "u1", nil),
		ActiveEnv: "dev", APIKeyMode: true})
	if err == nil || !errors.Is(err, ErrUsage) {
		t.Fatalf("want ErrUsage requiring --new/--id, got %v", err)
	}
	// same but --new → create
	d, err := decidePush(pushInput{File: "invoice.hbs", Map: entryMap("dev", "u1", nil),
		ActiveEnv: "dev", APIKeyMode: true, ForceNew: true})
	if err != nil || d.Action != pushCreate {
		t.Fatalf("want create with --new, got %+v err=%v", d, err)
	}
}

func TestAPIKeyModeSkipsAccountGuard(t *testing.T) {
	e := &localmap.Entry{TemplateID: "t1"}
	// map owned by another account, api-key mode, empty caller UserID → still updates
	d, err := decidePush(pushInput{File: "invoice.hbs", Map: entryMap("dev", "other", e),
		ActiveEnv: "dev", UserID: "", APIKeyMode: true})
	if err != nil || d.Action != pushUpdate || d.TemplateID != "t1" {
		t.Fatalf("api-key mode must skip account guard, got %+v err=%v", d, err)
	}
}
```

- [ ] **Step 2: Run — verify fail**

Run: `cd mkpdfs-cli && go test ./internal/cli/ -run 'TestAPIKeyMode' -v`
Expected: FAIL (`APIKeyMode` field undefined → compile error).

- [ ] **Step 3: Implement**

In `internal/cli/push_logic.go`, add the field to `pushInput`:

```go
	ForceNew        bool   // --new
	APIKeyMode      bool   // --api-key: no JWT, so skip account guard; require known/--new/--id
```

Then in `decidePush`, change the unknown/create branch and the account guard:

```go
	entry, known := in.Map.Templates[localmap.Key(in.File)]
	if !known {
		// In api-key (CI) mode, refuse to silently create on a missing mapping —
		// a retried pipeline would duplicate the template. Require --new (or --id).
		if in.APIKeyMode && !in.ForceNew {
			return pushDecision{}, fmt.Errorf(
				"no .mkpdfs.json entry for %q — pass --new to create a template or --id <templateId> to update an existing one: %w",
				in.File, ErrUsage)
		}
		return pushDecision{Action: pushCreate}, nil
	}
	if in.ForceNew {
		return pushDecision{Action: pushCreate}, nil
	}
	// Account guard does not apply in api-key mode (no JWT caller identity; the
	// token's userId enforces ownership server-side).
	if !in.APIKeyMode && in.Map.UserID != "" && in.Map.UserID != in.UserID && !in.Force {
		return pushDecision{}, fmt.Errorf(
			".mkpdfs.json was created by another account (%s). Use --force to push anyway: %w",
			in.Map.UserID, ErrUsage)
	}
```

Note: this replaces the old `if in.ForceNew || !known { return create }` block — `--id` handling above it is unchanged.

- [ ] **Step 4: Run — verify pass (incl. existing push tests)**

Run: `cd mkpdfs-cli && go test ./internal/cli/ -run 'Push|APIKeyMode|Decide' -v`
Expected: PASS — new tests + all existing decidePush tests (create-when-unknown in JWT mode still creates, env/account/conflict guards intact).

- [ ] **Step 5: Commit**

```bash
cd mkpdfs-cli
git add internal/cli/push_logic.go internal/cli/push_logic_test.go
git commit -m "feat(push): api-key mode — require --new/--id on unknown, skip account guard"
```

---

### Task 5: `--api-key` flag + wire templates commands to `/v1`

**Repo:** `mkpdfs-cli` (branch `feat/templates-api-key`)

**Files:**
- Modify: `internal/cli/templates.go` (flag, `templatesClient` helper, size cap, wire all 5 commands + push)
- Test: `internal/cli/templates_test.go` (new — pure helpers)

**Interfaces:**
- Consumes: `decidePush` with `APIKeyMode` (Task 4); `api.Client.WithAPIKey()` + auto-key (Task 3).
- Produces: `templatesClient() (*api.Client, string, error)` → (client, route-prefix); `maxTemplateBytes` constant.

- [ ] **Step 1: Write the failing test for the prefix/cap helpers**

Create `internal/cli/templates_test.go`:

```go
package cli

import "testing"

func TestTemplatesPrefix(t *testing.T) {
	if got := templatesPrefix(false); got != "/templates" {
		t.Errorf("jwt prefix = %q", got)
	}
	if got := templatesPrefix(true); got != "/v1/templates" {
		t.Errorf("api-key prefix = %q", got)
	}
}

func TestMaxTemplateBytes(t *testing.T) {
	// 6.5 MiB, under the ~7 MB effective ceiling.
	if maxTemplateBytes != 6_815_744 {
		t.Errorf("maxTemplateBytes = %d", maxTemplateBytes)
	}
}
```

- [ ] **Step 2: Run — verify fail**

Run: `cd mkpdfs-cli && go test ./internal/cli/ -run 'TemplatesPrefix|MaxTemplateBytes' -v`
Expected: FAIL (undefined `templatesPrefix` / `maxTemplateBytes`).

- [ ] **Step 3: Add the flag, helper, and constant**

In `internal/cli/templates.go`, add to the `var (...)` block:

```go
	tplAPIKey  bool
)

// maxTemplateBytes caps template source sent to the API. API Gateway REST has a
// 10 MB request limit; base64 inflates ~33%, so 6.5 MiB leaves room for JSON overhead.
const maxTemplateBytes = 6_815_744 // 6.5 * 1024 * 1024
```

In `addTemplatesCommands`, register the flag on the parent so all subcommands inherit it (place before `tplCmd.AddCommand(...)`):

```go
	tplCmd.PersistentFlags().BoolVar(&tplAPIKey, "api-key", false,
		"authenticate with MKPDFS_API_KEY / saved API key (server-to-server, no browser login)")
```

Add the helpers near `jwtClient`:

```go
// templatesPrefix returns the route prefix for templates given the auth mode.
func templatesPrefix(apiKey bool) string {
	if apiKey {
		return "/v1/templates"
	}
	return "/templates"
}

// templatesClient builds the API client + route prefix honoring --api-key.
func templatesClient() (*api.Client, string, error) {
	env, err := currentEnv()
	if err != nil {
		return nil, "", err
	}
	if tplAPIKey {
		c, err := api.New(env).WithAPIKey()
		return c, templatesPrefix(true), err
	}
	c, err := api.New(env).WithJWT()
	return c, templatesPrefix(false), err
}
```

- [ ] **Step 4: Run — verify the helper tests pass**

Run: `cd mkpdfs-cli && go test ./internal/cli/ -run 'TemplatesPrefix|MaxTemplateBytes' -v`
Expected: PASS.

- [ ] **Step 5: Wire list/get/pull/delete to use `templatesClient`**

Replace `jwtClient()` + hardcoded `/templates` paths in `runTemplatesList`, `runTemplatesGet`, `runTemplatesPull`, `runTemplatesDelete`, and `fetchTemplate` with `templatesClient()` and the returned prefix. Pattern (shown for list; apply the same to each):

```go
func runTemplatesList(cmd *cobra.Command, args []string) error {
	client, prefix, err := templatesClient()
	if err != nil {
		return err
	}
	resp, err := client.Get(prefix) // was client.Get("/templates")
	...
}
```

For `runTemplatesGet`/`runTemplatesPull`/`runTemplatesDelete`/`fetchTemplate`, build paths as `prefix+"/"+id`. `fetchTemplate` becomes:

```go
func fetchTemplate(id string) (*templateMeta, error) {
	client, prefix, err := templatesClient()
	if err != nil {
		return nil, err
	}
	resp, err := client.Get(prefix + "/" + id)
	...
}
```

- [ ] **Step 6: Wire push — client/prefix, userID, size cap, APIKeyMode, fetch via prefix**

In `runTemplatesPush`, make these changes:

(a) After the `hbs.Validate` block, enforce the size cap:

```go
	if len(content) > maxTemplateBytes {
		return fmt.Errorf("template %s is %s; the API limit is 6.5 MiB: %w",
			file, util.FormatBytes(int64(len(content))), ErrUsage)
	}
```

(b) Replace `client, err := jwtClient()` with `client, prefix, err := templatesClient()`.

(c) Only derive `userID` from the JWT in non-api-key mode (in api-key mode there is no JWT; leave it ""):

```go
	var userID string
	if !tplAPIKey {
		if creds := config.Get().Creds(env.Name); creds != nil && creds.IDToken != "" {
			if payload, err := auth.DecodeJWT(creds.IDToken); err == nil && payload != nil {
				userID = payload.Sub
			}
		}
	}
```

(d) Pass `APIKeyMode: tplAPIKey` into the `decidePush(pushInput{...})` call.

(e) The drift-fetch already calls `fetchTemplate(entry.TemplateID)` which now honors the prefix (Step 5) — no extra change.

(f) Build upload/PUT paths from the prefix:

```go
	if decision.Action == pushCreate {
		resp, err = client.Post(prefix+"/upload", body)
	} else {
		resp, err = client.Put(prefix+"/"+decision.TemplateID, body)
		if err != nil && resp != nil && resp.StatusCode == 404 {
			return fmt.Errorf("remote template %s no longer exists — your .mkpdfs.json entry is stale. Push with --new to create it again: %w",
				decision.TemplateID, ErrUsage)
		}
	}
```

- [ ] **Step 7: Build + full test suite**

Run: `cd mkpdfs-cli && go build ./... && go test ./... && go vet ./...`
Expected: build OK; all tests PASS; vet clean.

- [ ] **Step 8: Manual smoke against dev (api-key)**

```bash
make build
export MKPDFS_API_KEY=tlfy_…            # a dev key
./mkp-cli --env dev templates list --api-key
mkdir -p /tmp/ci && cd /tmp/ci && printf '<h1>{{t}}</h1>' > t.hbs
# unknown mapping without --new must fail (exit 2):
"$OLDPWD/mkp-cli" --env dev templates push t.hbs --api-key; echo "exit=$?"   # expect 2 + guidance
# create with --new, then push again (updates via map), then delete:
"$OLDPWD/mkp-cli" --env dev templates push t.hbs --api-key --new --yes
"$OLDPWD/mkp-cli" --env dev templates push t.hbs --api-key --yes
```
Expected: list works; bare push → exit 2 with `--new`/`--id` guidance; `--new` creates; second push updates; delete prunes.

- [ ] **Step 9: Commit**

```bash
cd mkpdfs-cli
git add internal/cli/templates.go internal/cli/templates_test.go
git commit -m "feat(templates): --api-key routes commands to /v1 (headless CI)"
```

---

### Task 6: Docs + smoke script

**Repo:** `mkpdfs-cli` (branch `feat/templates-api-key`)

**Files:**
- Modify: `README.md` (CI section)
- Modify: `scripts/smoke.sh` (headless block)

- [ ] **Step 1: Update the README CI section**

In `README.md`, replace the "Important: templates/tokens/auth are browser-only" note with:

```markdown
**Headless CI:** `pdf generate` and **`templates` (list/get/pull/push/delete)** work with an API key. Use `--api-key` (reads `MKPDFS_API_KEY` or the saved key):

```bash
export MKPDFS_API_KEY=tlfy_...
mkp templates push invoice.hbs --api-key          # requires a checked-in .mkpdfs.json entry
mkp templates push invoice.hbs --api-key --new    # create a new template headless
mkp templates pull <templateId> --api-key
```

`tokens`, `auth`, `usage`, and `credits` still require a browser login (Cognito JWT).
```

- [ ] **Step 2: Add a headless block to smoke.sh**

In `scripts/smoke.sh`, after the existing template push/generate checks, add (guarded so it only runs when a key is present):

```bash
if [[ -n "${MKPDFS_API_KEY:-}" ]]; then
  echo "--- headless: templates list via --api-key ---"
  "$BIN" --env dev templates list --api-key >/dev/null && echo "OK: api-key list"
  echo "--- headless: create + update + delete via --api-key ---"
  printf '<h1>{{t}}</h1>' > ci.hbs
  "$BIN" --env dev templates push ci.hbs --api-key --new --yes
  "$BIN" --env dev templates push ci.hbs --api-key --yes
  CIID=$(python3 -c "import json;print(json.load(open('.mkpdfs.json'))['templates']['ci.hbs']['templateId'])")
  "$BIN" --env dev templates delete "$CIID" --api-key --force
  echo "OK: api-key CRUD"
else
  echo "--- skipping headless api-key checks (set MKPDFS_API_KEY to run) ---"
fi
```

- [ ] **Step 3: Shellcheck / run smoke (optional, needs dev creds)**

Run: `bash -n scripts/smoke.sh` (syntax check). If a dev key + login are available: `MKPDFS_API_KEY=tlfy_… ./scripts/smoke.sh`.
Expected: syntax OK; full smoke passes when run against dev.

- [ ] **Step 4: Commit**

```bash
cd mkpdfs-cli
git add README.md scripts/smoke.sh
git commit -m "docs: document headless templates --api-key; smoke coverage"
```

---

## Self-Review

**Spec coverage:**
- 5 v1 routes + apiKeyOnly + reused cores → Tasks 1–2 ✓
- `grantDualAuth` on every v1 fn + least-privilege bucket grants → Task 2 ✓
- CLI `--api-key` on list/get/pull/delete/push → Tasks 3, 5 ✓
- push: drift via v1, account-guard skipped, env-guard + drift preserved, `--new`/`--id` idempotency → Tasks 4, 5 ✓
- JSON base64 + 6.5 MiB cap → Task 5 ✓
- Security (Bearer rejected, missing-key 401) → Task 2 curl ✓
- README + smoke → Task 6 ✓
- Deferred (token scopes, usageTracking-201 bug, subscription-402) → noted in spec, no task (correct) ✓

**Placeholder scan:** none — every code/curl/command step has concrete content.

**Type consistency:** `templatesClient()`/`templatesPrefix()`/`maxTemplateBytes`/`APIKeyMode`/`tplAPIKey` used consistently across Tasks 3–6; wrapper `main` exports and core named exports consistent across Tasks 1–2.
