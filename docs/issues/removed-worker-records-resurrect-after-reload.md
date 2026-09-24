# Removed worker records resurrect after a session reload

- Category: bug (state consistency)
- Severity: lower
- Found during: post-mission live verification, 2026-09-24
- Status: open

## Evidence

Four worker records were removed with `workers (action=remove)` during the
lower-sev issue mission. Each removal confirmed deletion ("record, stream
spool and patch deleted. Worktree and branch discarded."), and
`.pi/workers/records/` held no file for them afterwards.

After a session reload, `workers (action=list)` reported all four again,
alongside the records that were legitimately kept as history. A directory
check confirmed the contradiction: `.pi/worktrees/` held only the one live
worker, and the resurrected ids had no file under `.pi/workers/records/`.

The mechanism: `remove` deletes the disk artifacts (record file, spool,
patch, worktree), but the worker's entries in the session transcript are
immutable history. On reload, `refreshFromBranch` (`agents.ts:173`) replays
the branch through `loadWorkersFromBranch` and re-materializes every record
it finds, with no tombstone or removal marker to honor — the string
"removed" appears nowhere in `src/store.ts` or `src/actions.ts` outside a
worktree-cleanup line.

Secondary instance, same testing session: `w-mufyf6ds` has a complete
record file (id, name, full task text) even though its spawn was refused by
the dirty-tree gate before any worktree or process existed. The record is
written before the refusal is decided, or is not cleaned up on refusal.

## Impact

No capacity cost — resurrected workers are terminal, and terminal workers
consume no slot. The damage is trust and noise:

- `workers list` grows a permanent ghost section that no `remove` can clear
  (removal "succeeds", then undoes itself on the next reload).
- Ghosts render stale activity lines, so the list misrepresents what exists.
- An orchestrator can waste calls on `status`/`tail` against ids whose
  streams and worktrees are gone.
- The refused-spawn record advertises a worker that never ran.

## Resolution direction

Pick one lifecycle rule and enforce it at refresh time:

1. Tombstone on remove: `remove` appends a `worker-removed` marker to the
   transcript; `refreshFromBranch` skips ids with a marker. History stays
   intact; the list stays truthful.
2. Prune at refresh: drop transcript records that have neither a disk record
   file nor a stream file — legitimately kept history (e.g. collected or
   timed-out workers) always has at least one, removed workers have neither.
   Cheapest, but the rule is implicit; document it where records are loaded.
3. Separately, defer record persistence until the spawn actually succeeds,
   so a refused spawn leaves nothing behind.
