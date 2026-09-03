# Goal Extension

Goal-oriented auto-continuation mode — tell Pi what to accomplish and it keeps going until an independent evaluator confirms the goal is met.

## What It Does

The `/goal:*` commands activate a persistence mode where the agent autonomously continues working on an objective. After every turn, a small-model evaluator judges the conversation evidence against the objective with a three-way verdict:

- **met** — the goal clears and a completion notice is shown.
- **not yet met** — the evaluator's reason becomes the guidance for the next automatic continuation.
- **impossible** — the goal pauses and the reason is reported.

The evaluator never calls tools. Like Claude Code's native `/goal` judge, it weighs only the evidence the agent already surfaced in the transcript (tool results, command output, files changed), so completion is decided by evidence rather than the working model's self-report.

## Usage

### Start a goal

```
/goal:new implement a snake game in the terminal
/goal:new --iterations 10 refactor the auth module
```

`/goal` is an alias for `/goal:new` — it starts a goal the same way.

Running `/goal:new` with no objective opens the shared framed input modal (`lib/input-modal.ts`, the same dialog `/handoff` uses) so the objective can be typed interactively.

The `--iterations` flag caps automatic continuations (default 25; `--iterations 0` means unlimited). Write a verifiable objective — a measurable end state, the command or evidence that proves it, and any constraints — because the evaluator judges against the transcript.

### Check status

```
/goal:status
```

Shows the objective, status, elapsed time, token spend (display only), iteration count, and the evaluator's most recent reason.

### Edit the objective

```
/goal:edit implement a tetris game instead
/goal:edit
```

Updates the objective text without resetting usage counters. With no inline objective, `/goal:edit` opens the input modal prefilled with the current objective. If the goal is active, a follow-up prompt is sent informing the agent of the change.

### Pause and resume

```
/goal:pause
/goal:resume
```

Pausing stops auto-continuation. Resuming sends a follow-up prompt telling the agent to continue from where it left off and resets the no-progress counter.

### Reset

```
/goal:reset
```

Cancels the goal entirely, clears the status line, and resets all internal state. Resetting is destructive, so it asks for confirmation first.

## How It Works

### Goal lifecycle

1. **Start** — `/goal:new <objective>` creates a `GoalState` object and persists it via `appendEntry("goal-state", ...)`. A follow-up user message is sent with the objective and persistence rules.

2. **Per-turn reminder** — On every `before_agent_start`, if a goal is active, the extension injects a tail-position message (custom type `goal-context`) carrying the objective and goal-mode rules. A `context` handler strips all stale copies, so the request prefix stays byte-stable across turns — the system prompt is never modified, which keeps provider prompt caching intact.

3. **Evaluation** — On `agent_end`, while the goal is active and no messages are pending, the extension sends the objective plus a bounded recent transcript to the global small model (`lib/small-model.ts`) via `completeSimple`. The verdict must be a JSON object: `{"status":"met"|"not_met"|"impossible","reason":"..."}`.

4. **Continuation** — On `not_met`, the extension queues a follow-up message carrying the evaluator's reason as guidance and increments the iteration count.

5. **Completion** — On `met`, the goal is persisted as complete and the status line shows "complete" for 8 seconds.

6. **Interruption handling** — If a message ends with `stopReason: "aborted"` or `"error"`, the goal is automatically paused. If evaluation itself fails (no small model configured, API error, unparseable verdict), the goal stays active and control returns to the user — the loop never continues on a broken evaluator.

### Runaway guards

Two guards replace the old token budget:

- **Iteration cap** — after `maxIterations` automatic continuations (default 25, `--iterations 0` for unlimited), the goal pauses.
- **No-progress detection** — three consecutive continuation turns with no tool calls pause the goal; the model is churning, not working. Tool use or an explicit `/goal:resume` resets the counter.

### State persistence

Goal state is persisted via `appendEntry("goal-state", { goal })`. On `session_start`, the extension walks the branch backwards looking for the most recent `goal-state` entry and reconstructs the state. Completed goals are skipped. Sessions persisted before the token budget was removed carry status `"budget"`, which is normalized to `"paused"`.

### State scope

The extension keeps state in closure variables (`state`, `continuationQueued`, `evaluating`, `completionStatusTimer`) that are reset on `session_start` and `session_shutdown`. Only one goal can be active at a time.

## Key Design Decisions

- **The system prompt is never modified** — the old design appended a per-turn-varying system prompt section, which invalidated the provider prompt cache on every turn. Goal context now enters as a stripped-and-re-injected tail message (the same pattern the `plan` extension uses), so cached prefixes survive.
- **No LLM-facing completion tool** — the old `goal_complete` tool let the working model self-report completion (and its enable/disable toggling churned the tool schema). The small-model evaluator is the sole completion authority, so there is nothing to toggle.
- **No token budget** — budget counters in prompts broke caching, and budget-as-prompt-content is an anti-pattern. Token spend is still tracked for `/goal:status` display only. Bounding is done with the iteration cap and no-progress guard.
- **Fail-safe evaluation** — an evaluator failure never silently continues the loop; it notifies and hands control back.
- **Confirmation on replacement** — starting a new goal while one is active (and not complete) triggers a `ui.confirm()` dialog to prevent accidental replacement.
- **Reset confirmation** — `/goal:reset` wipes the objective and all usage counters, so it requires a `ui.confirm()` before proceeding.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerCommand(...)` | Registers the seven `/goal*` slash commands |
| `pi.appendEntry("goal-state")` | Persists goal state to the session branch |
| `pi.sendUserMessage()` | Sends start, resume, edit, and continuation prompts |
| `pi.on("before_agent_start")` | Injects the per-turn goal-context message |
| `pi.on("context")` | Strips stale goal-context copies from history |
| `pi.on("agent_end")` | Runs the evaluator; queues continuation or completes/pauses |
| `pi.on("message_end")` | Pauses goal on abort/error |
| `pi.on("turn_end")` | Tracks token spend and elapsed time |
| `pi.on("session_start")` / `pi.on("session_tree")` | Reconstruct state from branch entries |
| `pi.on("session_shutdown")` | Persists final state |
| `pi.on("input")` | Cancels pending continuation on user input |
| `ctx.ui.setStatus()` | Status line (active, paused, complete); suppressed by the status-bar extension in favor of its **Goal** badge |
| `pi.events.emit("goal:state-change")` | Publishes goal state; the status-bar extension shows a **Goal** badge in the editor frame while a goal is running |
| `ctx.ui.confirm()` / `ctx.ui.notify()` | Confirmations and status messages |
| `ctx.getContextUsage()` | Token spend tracking (display only) |
| `completeSimple()` + `lib/small-model.ts` | The global small model, used for completion evaluation |

## Configuration

No flags on the extension itself. The evaluator uses the global small model — configure it with `/smallmodel` or the `PI_SMALL_MODEL` environment variable (see `extensions/small-model/`).
