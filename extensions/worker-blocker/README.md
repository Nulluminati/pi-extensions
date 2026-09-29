# Worker Blocker Extension

Worker-side half of the blocker-reporting channel between delegated worker sessions and their parent. Gives a worker's model a `report_blocker` tool to declare "I cannot proceed" with one short reason, so the parent learns the concrete obstacle instead of watching the worker burn its time budget.

## What It Does

The worker calls `report_blocker` with a one-line reason (for example: "no AWS credentials in the sandbox; deployment task cannot run"). The sanitized reason is appended as a `workers_blocker` marker to the worker's own event spool — the same file the parent session already tails for live activity. The parent wakes once (the wake carries ids and status words only), then reads the full reason through its `workers` tool (`action=status`).

## Design Notes

- **Pull-only output boundary.** Nothing here routes through messenger. Worker output never enters the parent conversation; the reason is read back on demand through the `workers` tool.
- **Reporting is not stopping.** A blocker report never halts the worker session. The tool's result tells the model to continue if useful progress is still possible; the parent decides whether to adjust the task or cancel the worker to free its slot.
- **Sanitized and bounded.** Reasons are trimmed to `BLOCKER_REASON_MAX_CHARS` and sanitized by `lib/worker-blocker.ts` before transport. An empty reason reports nothing rather than failing the call.
- **Fail loudly.** If the marker cannot be appended to the spool, `report_blocker` throws with the underlying error instead of pretending the report was delivered.

## Registration Rules

The extension registers nothing outside worker sessions. It activates only when both are true:

1. `PI_WORKER=1` — the session is a delegated worker.
2. `PI_WORKER_STREAM` — the runner set the worker's spool path.

The main session's model never sees the `report_blocker` tool.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerTool("report_blocker")` | The worker-facing blocker tool |

## Related

- `lib/worker-blocker.ts` — marker type, reason sanitizing, and size limits shared with the workers extension.
- `extensions/workers/` — the parent side: spool tailing, blocker wake messages, and `workers` tool surfacing.
