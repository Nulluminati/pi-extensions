# Blocker errors don't name the blocker

- Category: UX/design (operability)
- Severity: important
- Found during: PR #33 second-round review, 2026-09-21
- Status: open

## Evidence

`createWorktree()` in `extensions/agents/src/worktree.ts` runs `git status --porcelain`, counts blocking lines, then refuses with:

```
Refusing to create a worker worktree from a dirty tree. Commit or stash first so the worker's patch captures a clean baseline.
```

The offending paths are already in hand but are not included in the message. Observed during this review: two delegate launches were refused; the actual blocker was an untracked `docs/` directory. Diagnosing it required a separate manual `git status`.

The same pattern appears in `cancelWorker()` (`extensions/agents/src/actions.ts`): a `cancel` on a worker that already reached a terminal state returns `Worker <id> is already <status>` with no guidance. Repeating the call gives the same message every time.

## Impact

The parent agent must run extra diagnostic tool calls to learn what the extension already knows. Repeated failed calls waste turns and can spiral (six consecutive `cancel` calls on one timed-out worker during this session).

## Resolution direction

1. Include the blocking paths in the dirty-tree error, truncated to a handful with a count of the rest. The data is collected two lines above the throw.
2. For `cancel` on a terminal record, state that no action is needed and name the useful next steps: the slot is already free, `remove` deletes the record, `delegate` starts a new worker.
