# Worker presence status bypasses the pull-only output boundary

- Category: design (trust boundary)
- Severity: lower
- Found during: PR #33 second-round review, 2026-09-21
- Status: open

## Evidence

Worker sessions are gated for `messenger send` (`extensions/messenger/src/actions.ts:64-77` checks `PI_WORKER === "1"`), which is what enforces the pull-only output boundary documented in `extensions/messenger/README.md`: worker output reaches the parent only through the workers tool.

The `status` action has no such gate (`actions.ts:134-147`). A worker's model can publish arbitrary text to its own presence shard via `messenger (action=status, status="...")`, and every peer renders that text through `messenger list` (`src/format.ts:18-27`).

## Impact

Narrow, because it is pull-based — nothing auto-delivers into another conversation and no `triggerTurn` fires. But it contradicts the documented guarantee as written, and gives a worker a model-controlled text channel into every peer's `list` output.

## Resolution direction

Gate the `status` action for worker sessions, or restrict worker status strings to a bounded enum chosen by the runner rather than free text. Update the README wording to match whichever is chosen.
