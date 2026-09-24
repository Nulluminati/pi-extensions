# Workers lack a narrowed blocker-reporting channel

- Category: UX/design (design question)
- Severity: lower
- Found during: PR #33 second-round review, 2026-09-21
- Status: open, needs a decision

## Evidence

Before the pull-only output boundary was enforced, workers reported blockers proactively through `messenger send`. Real example from this session: "Blocker: this Gondolin VM has no node_modules and no parent checkout" arrived in the parent's conversation the moment the worker settled, and the parent could react immediately.

After the fix (`PI_WORKER=1` gates `send` in `extensions/messenger/src/actions.ts`), that channel is gone by design. Worker output now reaches the parent only through `workers status/tail`. The trade: a worker that cannot proceed sits silent until its timeout, and the parent learns of the blocker only if it polls.

The boundary itself is correct and was requested in round one of the review. The gap is narrower: there is no channel for the specific, bounded signal "I cannot proceed, here is why."

## Impact

Blocked workers hold their concurrency slot until timeout (default 900s), and their blockers are discovered late. In this session, two workers burned their full budgets on environment problems that a blocker report would have surfaced in seconds.

## Resolution options (decision needed)

1. A dedicated worker-side `report_blocker` tool that writes a short, bounded reason onto the worker record and emits a trusted wake to the parent ("worker <name> reports a blocker; use workers status for details"). The wake stays ids-and-status-words only; the reason text lives behind the pull boundary.
2. The same mechanism as a scoped `messenger` action: workers may send to their parent only, with a hard length cap, delivered as a trusted wake rather than auto-injected mail.
3. Leave as-is and rely on timeout detection plus `workers tail` polling.

Option 1 keeps the pull-only guarantee intact (the wake carries no worker-generated prose) while restoring fast blocker discovery. Whatever is chosen, the payload must be length-capped and sanitized like existing wake messages.
