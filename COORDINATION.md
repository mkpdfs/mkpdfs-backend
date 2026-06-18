# Coordination — multi-session work in progress

⚠️ More than one session/agent works in this repo concurrently. Be careful with
shared state.

**Incident (2026-06-18):** `dev` was force-reset to an earlier commit, which
orphaned an already-pushed commit (PDF-perf docs) and left the orchestrator's
`mkpdfs-backend` submodule pointer dangling. It was recovered.

**Guardrail now in place:** `dev` and `main` have branch protection blocking
**force-push** and **deletion** (`enforce_admins: true` — applies to admins too).
Normal fast-forward `git push` still works; no PR/review required.

**Rules to avoid stepping on each other:**
- Rebase feature branches on `origin/dev` — do **not** reset or force-push
  `dev`/`main`.
- To rewrite `dev`/`main` history you must temporarily lift branch protection
  (admin) — coordinate first so you don't orphan someone's pushed commit.
- Note the checkout may be on a shared branch; don't assume `dev` is checked out.

---

## CLI release coordination — `/v1/templates` headless feature (#2)

**Status (2026-06-18, this session):** The headless `/v1/templates/*` API-key routes
are merged to `origin/dev` (merge `fba9f778`) and **live on dev** (CI deployed;
`GET /v1/templates` → 401 with no key, as expected). They are **NOT in prod yet** —
`origin/main` lacks the merge and prod `GET /v1/templates` → 403.

The companion CLI feature (`mkp templates … --api-key`, repo `mkpdfs-cli`) is merged to
the CLI's local `main` and ready to ship as **v0.3.0**, but the release is **HELD** —
**do not cut the CLI release until backend `/v1` is in PROD.** Releasing the CLI first
would ship a `--api-key` flag that 403s against prod (routes not deployed).

**Ordering needed:**
1. ~~Promote backend `dev` → `main` (lands `/v1` in prod).~~ **DONE** (this session, 2026-06-18):
   `main` fast-forwarded to `751ba06e`; CI "Deploy main" succeeded; prod API Gateway stage
   redeployed (`aws apigateway create-deployment` on `ni9r76mk4l`/`prod` — needed because the
   stage served a stale snapshot, same gotcha as dev).
2. ~~Verify prod `GET /v1/templates` → 401.~~ **DONE** — prod returns 401 for no-key /
   forged-Bearer / bad-key (route + apiKeyOnly live, forged-JWT rejected).
3. **NOW UNBLOCKED:** cut CLI `mkpdfs-cli` v0.3.0 (labeled PR `release:minor` or tag).
   The CLI feature is merged to the CLI's local `main`; release pending an explicit go.

Delete this file once concurrent work settles.
