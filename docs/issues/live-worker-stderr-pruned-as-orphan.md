# Live worker stderr is pruned as an orphan

- Category: worker diagnostics
- Severity: moderate
- Status: open

## Evidence

`pruneStreams` in `extensions/agents/src/store.ts` treats every file under `streams/` as a `.jsonl` spool. For `w-1.stderr.log`, the suffix replacement does nothing. The resulting id, `w-1.stderr.log`, matches no worker record, so the next session start deletes the log even while `w-1` runs.

The same module deletes the `.jsonl` spool during removal and retention, but leaves the paired `.stderr.log` untouched. The incorrect orphan pass is currently the only cleanup for stderr logs.

## Impact

A worker that fails after the log disappears loses its error detail. `workers status` can report a missing response instead of the child process's real failure.

## Resolution

Match `.jsonl` spools and `.stderr.log` files to the same worker id. Keep both for running workers, then remove both under the existing retention and explicit removal rules. Test a live worker, an old terminal worker, and explicit removal.
