# Unscoped patch capture swallows worker artifacts

- Category: bug (data quality) / design
- Severity: important
- Found during: PR #33 second-round review, 2026-09-21
- Status: open

## Evidence

`captureWorktreePatch()` in `extensions/agents/src/worktree.ts` runs `git add -A` in the worktree, then diffs against the recorded base commit. `add -A` stages every untracked file in the worktree, including artifacts the worker created at runtime.

Observed: a worker ran `npm ci` with its cache inside the worktree, creating `.npm-cache/_cacache/**`. The captured patch contained hundreds of binary cache entries. Applying it failed with repeated `cannot apply binary patch ... without full index line` errors, making the patch unusable.

This is the same root cause as review finding F4 (patch capture relies on `excludeFromGit` hygiene to keep `.pi` state out of the patch), with a different trigger: any untracked artifact directory the worker creates contaminates the patch.

## Impact

A contaminated patch cannot be applied by `collect`; the worker's actual changes are entangled with cache noise and effectively lost unless the worktree is kept and mined by hand. The failure surfaces only at collect time, after the worktree may already be gone in the default cleanup flow.

## Resolution direction

1. Capture with explicit pathspec excludes instead of bare `add -A`: exclude the config state dir and known artifact locations (`.npm-cache`, `node_modules`, or better, anything matched by a small denylist), so worker runtime artifacts never enter the diff.
2. Validate before storing: run `git apply --check` against the parent tree at capture time. A patch that cannot apply fails at capture with a clear error while the worktree still exists, instead of at collect.
