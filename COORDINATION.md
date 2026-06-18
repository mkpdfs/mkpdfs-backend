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

Delete this file once concurrent work settles.
