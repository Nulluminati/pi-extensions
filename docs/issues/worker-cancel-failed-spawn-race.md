# Cancelling a failed worker spawn can interrupt shutdown

- Category: worker lifecycle / cleanup
- Severity: low
- Status: open

## Evidence

`startWorker` in `extensions/agents/src/runner.ts` resolves its `started` promise to `undefined` after a spawn failure. `cancel()` then reads `child.pid` without checking whether `child` exists. A cancellation in the gap before failure finalization throws instead of settling the worker.

`session_shutdown` awaits each worker's `cancel()` call. A rejection can stop that loop before it cancels other workers.

## Impact

The shutdown path can leave live workers behind after a separate worker fails to spawn. A waited delegate's abort handler can also reject without handling the error.

## Resolution

Guard the missing child before reading its pid, and let `finish` settle the failed record once. Test cancellation after a nonexistent worker binary and shutdown with another live worker.
