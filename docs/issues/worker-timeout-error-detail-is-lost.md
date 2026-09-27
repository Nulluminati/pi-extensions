# Worker timeout loses its error detail

- Category: worker UX / diagnostics
- Severity: moderate
- Status: open

## Evidence

`finish(statusOverride, _errorOverride)` in `extensions/agents/src/runner.ts` ignores its error parameter. The close handler passes `worker exceeded Ns timeout`, but `finalizeWorker` receives only `statusOverride: "timeout"`. It clears `record.error`, so `workers status` shows a timeout without the duration or cause. The child `error` handler also adds its message only after finalization has persisted and notified the parent.

## Impact

The saved record and wake message omit the reason a worker stopped. A spawn error can reach the caller after the durable record and notification already say only `failed`.

## Resolution

Pass the error override into `finalizeWorker` before persistence. Use the same path for child process errors. Test a timed-out child and a spawn error against the saved record and notification.
