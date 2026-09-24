# cancel vs remove semantics don't map to the mental model

- Category: UX/design (operability)
- Severity: lower
- Found during: PR #33 second-round review, 2026-09-21
- Status: resolved (2026-09-24)

## Evidence

The natural mental model for "I need the worker slot back so I can relaunch" is `cancel`. In the implementation, a worker that reached any terminal state consumes no slot at all; `cancel` only signals a live process, and `remove` is pure record/artifact cleanup.

Nothing in the `workers` tool description, its parameter descriptions, or the extension's `promptGuidelines` states this lifecycle. The failure mode is visible in this session: `cancel` was called on a timed-out worker six times because each response (`Worker <id> is already timeout`) did not redirect to the action that would have helped.

## Impact

Wasted tool calls and a stalled orchestration loop when the parent is waiting on worker capacity it believes is occupied.

## Resolution direction

1. Document the slot lifecycle in the tool description: running workers hold a slot; terminal workers do not; `cancel` is for live processes only; `remove` is cleanup only.
2. Make the terminal-state `cancel` error carry the redirect: "already <status>; its slot is free. Use action=remove to delete the record or delegate to start a new worker."

## Update (2026-09-24, after the session-scoping rework)

Partially addressed since this was written:

- `remove` now also discards the worker's worktree and branch, and handles an
  id with no record but a leftover worktree — the action descriptions in
  `src/schemas.ts` state this explicitly.
- `cancel` now covers live orphans (pid-based kill, finalized as cancelled)
  and adopted workers after `pi -c`, so "cancel only signals a live process
  in the live map" is no longer true.
- The repeating failure mode from the observed session (six blind `cancel`
  calls on a timed-out worker) is mitigated structurally: timed-out workers
  finalize immediately, and status responses state the terminal status.

What remains of the finding: the mental-model mapping (cancel = stop the
process; remove = delete the record/artifacts; terminal states consume no
slot) is documented only in these descriptions, not in `promptGuidelines`,
and cancel's error message for a foreign *live* session's worker still does
not redirect to a useful action. Decide whether to fold the lifecycle into
the delegate promptGuidelines or leave it to tool descriptions.

## Resolution (2026-09-24)

All three changes landed:

1. The delegate tool's `promptGuidelines` now carry a lifecycle guideline:
   only running workers hold a slot, workers in a terminal state consume
   none, `cancel` stops a live process, `remove` deletes the terminal
   worker's record and artifacts, and relaunching is just delegating again.
2. The `workers` tool description and the `action` parameter description in
   `src/schemas.ts` state the same lifecycle explicitly up front.
3. `cancelWorker` redirects: a terminal-state worker now answers "is already
   <status>; its slot is free. Use action=remove to delete the record and
   artifacts, or delegate to start a new worker." (both the no-live-record
   error and the raced-at-exit response), and the foreign-live error now
   clarifies the worker holds no slot in this session and points at
   `workers action=list scope=all` or a fresh `delegate`.
