# Aborting a waited delegate during setup still starts the worker

- Category: worker cancellation / UX
- Severity: moderate
- Status: open

## Evidence

The `delegate` tool in `extensions/agents/agents.ts` attaches its abort listener only after `startDelegatedWorker` returns. That function can spend minutes in provision preflight, worktree creation, and the setup hook before it starts the child. A signal that aborts during setup is already aborted when the listener is attached; no event fires for it.

## Impact

A user can cancel a waited delegate call, but setup continues and starts a worker. That worker consumes a slot and tokens after cancellation.

## Resolution

Check an already-aborted signal before the spawn. Thread cancellation through the setup path, and attach the post-spawn cancel handler without a gap. Test abort during a blocked setup hook and assert no child starts.
