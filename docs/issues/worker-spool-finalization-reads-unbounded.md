# Worker finalization reads the full stream spool

- Category: worker resource use / code quality
- Severity: low
- Status: open

## Evidence

`STREAM_MAX_BYTES` in `extensions/agents/src/store.ts` describes a 512 KB cap and a truncation marker, but no writer enforces it. `finalizeWorker` in `extensions/agents/src/runner.ts` passes `Number.MAX_SAFE_INTEGER` to `readTailLines`, so each finalization allocates the whole spool. A noisy worker can write far beyond the declared cap before its hard timeout.

## Impact

A large spool can use substantial memory when the parent or a later janitor finalizes the worker. Repeated adoption attempts can repeat that cost.

## Resolution

Enforce a bounded stream size or parse a bounded tail at finalization. Keep enough information for status and error attribution, and make the truncation rule accurate. Test finalization with a spool larger than the limit.
