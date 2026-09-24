# Worktree isolation doesn't provision the dev environment

- Category: UX/design (design decision needed)
- Severity: important
- Found during: PR #33 second-round review, 2026-09-21
- Status: open, needs a decision

## Evidence

`createWorktree()` branches from HEAD into `.pi/worktrees/<id>`. A fresh worktree has no `node_modules`, and a worker running inside the Gondolin VM has no access to the parent checkout and very little free disk (~15 MB observed).

Two workers assigned tasks whose verification step was "run the tests" spent their entire budget attempting `npm ci` inside the worktree instead of performing the task. Both timed out with no code changes.

## Impact

Any delegated task whose verification involves running the project's test suite — the common case for implementation work — fails or burns its budget in environment setup when `isolate: true` (the default).

## Resolution options (decision needed)

1. Provision at worktree creation: symlink or copy `node_modules` from the parent checkout into the worktree. Cheapest for workers; needs a guard for projects where a copied `node_modules` is invalid (native builds, bin paths).
2. Warn at delegate time: when the task text mentions running tests/checks and `isolate` is not explicitly false, the tool result includes a caution that isolated workers cannot run installs and may fail verification.
3. Document the constraint: `isolate: false` is the right choice for test-verifying tasks; isolated workers are for read-only research and self-contained edits.
4. Allow controlled installs: pre-seed a writable npm cache location inside the VM and document that workers may install. Highest trust cost; interacts with the patch-contamination issue.

Options 2 and 3 can combine; option 1 is the real fix if symlinking proves safe.
