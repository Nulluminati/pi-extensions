# Adopted workers lose their hard timeout

- Category: worker lifecycle / resource safety
- Severity: moderate
- Status: open

## Evidence

`startWorker` in `extensions/agents/src/runner.ts` keeps the hard timeout in a timer owned by the spawning Pi process. The durable `WorkerRecord` has no deadline. After that process exits unexpectedly, an adopter watches the surviving child but cannot recover its time limit.

## Impact

A worker can run without a bound after a parent crash. It can continue using model tokens until another session cancels it manually.

## Resolution

Persist a deadline with the worker record. Re-arm the remaining time during adoption, and terminate a worker whose deadline has passed. Test adoption of a live worker with an expired deadline.
