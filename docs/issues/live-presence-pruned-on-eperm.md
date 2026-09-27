# Presence pruning treats a live process as dead on EPERM

- Category: messenger safety
- Severity: moderate
- Status: open

## Evidence

`isProcessAlive` in `lib/presence-shards.ts` returns `false` for every error from `process.kill(pid, 0)`. An `EPERM` error means the process exists but the caller cannot signal it. `lib/file-lock.ts` already handles this case as live.

A peer that loads the registry can then prune a live session's shard. Its name may be claimed by another session. Its path reservations can enter the orphan grace period and expire while it still works.

## Impact

Mail can route to the wrong mailbox, and peers can edit paths held by a live session. This is most likely when sessions share a project across user accounts or a sandbox denies signal checks.

## Resolution

Treat `EPERM` as live. Keep the conservative result for other uncertain permission failures. Test shard pruning and reservation lifetime with a simulated `EPERM` from `process.kill`.
