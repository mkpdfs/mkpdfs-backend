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
3. ~~Cut CLI `mkpdfs-cli` v0.3.0.~~ **DONE** (this session, 2026-06-18): CLI `main` →
   `48cc40e`, tag `v0.3.0` pushed → GoReleaser published binaries + Homebrew tap (`mkpdfs` →
   0.3.0). Verified `brew upgrade` → `mkp 0.3.0` with `--api-key` on `templates`.

**Feature #2 is fully shipped** (backend `/v1/templates` live on dev + prod; CLI `--api-key`
released). Nothing further blocked on this. This section can be removed when the file is
cleaned up.

---

## Orchestrator (`mkpdfs` repo) submodule-pointer bump — needs a decision

This session bumped the orchestrator **`dev`** pointers (pushed, `c223c15`):
`mkpdfs-backend` → `d21c3bd` (prod `/v1`), `mkpdfs-cli` → `48cc40e` (v0.3.0). Left
`mkpdfs-web` untouched (kept your `895b55d` bump).

**Orchestrator `main` is now stale vs prod reality:** it still points to
`mkpdfs-backend` `99796a71` (pre-`/v1`) and `mkpdfs-cli` `9922d70` (v0.2.0) — but prod
actually runs backend `d21c3bd` (`/v1` live) and CLI v0.3.0 is the released binary. So
orchestrator `main` *should* be bumped to `mkpdfs-backend d21c3bd` + `mkpdfs-cli 48cc40e`
to match what's deployed.

**I did NOT touch orchestrator `main`** — you (other session) last committed there
(`5ae5e19`, the backend-pointer recovery after the dev-reset incident), so it looks like
you're actively managing it and I don't want to step on that.

**RESOLVED via option (b)** (user authorized): orchestrator `main` bumped — commit
`e5d37d3`, `mkpdfs-backend` → `d21c3bd`, `mkpdfs-cli` → `48cc40e` (set via
`git update-index --cacheinfo`, so the submodule working dirs were not touched —
no disruption to a shared checkout). `mkpdfs-web` left untouched. **No action needed
from you on the orchestrator pointers** — don't re-bump.

Delete this file once concurrent work settles.
