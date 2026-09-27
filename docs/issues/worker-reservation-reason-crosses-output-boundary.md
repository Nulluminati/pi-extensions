# Worker reservation reasons reach peer tool output

- Category: worker trust boundary
- Severity: low
- Status: open

## Evidence

`messenger reserve` in `extensions/messenger/src/actions.ts` accepts a free-text `reason` from worker sessions. `formatBlockReason` places that text in the error shown when another session touches the reserved path. Worker status is restricted to a fixed set because peers render it, but reservation reasons have no such restriction.

## Impact

A worker can put arbitrary instructions into another session's tool result when that session hits its reservation. The text is not sent as a wake, but it still crosses the intended pull-only worker output boundary.

## Resolution

Do not render free-text worker reasons to peers. Reject them or use a bounded fixed value for worker reservations. Test a worker reason and the peer's edit-block response.
