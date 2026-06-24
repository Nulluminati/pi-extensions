# Goal Extension

Goal-oriented auto-continuation mode — tell Pi what to accomplish and it keeps going until it's done.

## What It Does

The `/goal` command activates a persistence mode where the agent autonomously continues working on an objective until it is fully complete and verified. Instead of stopping after a single turn, the agent is automatically continued with instructions to keep working from where it left off.

A `goal_complete` tool is registered so the LLM can signal when it has finished, preventing infinite loops.

## Usage

### Start a goal

```
/goal implement a snake game in the terminal
/goal --tokens 100k refactor the auth module
```

The `--tokens` flag sets a token budget. When the budget is reached, the goal pauses and you can resume or clear it.

### Check status

```
/goal
/goal status
```

Shows the objective, status, elapsed time (or token usage), and iteration count.

### Edit the objective

```
/goal edit implement a tetris game instead
```

Updates the objective text without resetting usage counters. If the goal is active, a follow-up prompt is sent informing the agent of the change.

### Pause and resume

```
/goal pause
/goal resume
```

Pausing stops auto-continuation. Resuming sends a follow-up prompt telling the agent to continue from where it left off.

### Clear

```
/goal clear
```

Cancels the goal entirely, clears the status line, and resets all internal state.

## How It Works

### Goal lifecycle

1. **Start** — `/goal <objective>` creates a `GoalState` object and persists it via `appendEntry("goal-state", ...)`. A follow-up user message is sent with the objective and persistence rules.

2. **System prompt injection** — On every `before_agent_start`, if a goal is active, the extension appends a system prompt section with the objective and goal-mode rules. This reminds the agent to keep working.

3. **Auto-continuation** — On `agent_end`, if the goal is still active, no `goal_complete` was called, and there are no pending messages, the extension sends a continuation follow-up message via `sendUserMessage()`. The agent receives this as a new prompt and continues working.

4. **Completion** — The LLM calls the `goal_complete` tool when it believes the objective is fully met. This sets status to "complete", stops auto-continuation, and shows "🎯 complete" in the status line for 8 seconds.

5. **Interruption handling** — If a message ends with `stopReason: "aborted"` or `"error"`, the goal is automatically paused.

### Token budgets

When `--tokens` is specified:
- The extension tracks token usage by comparing `getContextUsage().tokens` against the baseline at goal start
- On `agent_end`, if `tokensUsed >= tokenBudget`, the goal is set to "budget" status and paused
- You can resume (if usage dropped) or edit to increase the budget

### State persistence

Goal state is persisted via `appendEntry("goal-state", { goal })`. On `session_start`, the extension walks the branch backwards looking for the most recent `goal-state` entry and reconstructs the state. Completed goals are skipped during reconstruction.

### Module-level state

The extension uses module-level variables (`state`, `goalCompleteCalled`, `continuationQueued`, `completionStatusTimer`) that are reset on `session_start` and `session_shutdown`. This is the simplest pattern because only one goal can be active at a time.

## Key Design Decisions

- **Persistence rules in prompts** — Every follow-up and system prompt includes explicit instructions not to stop at analysis, plans, TODOs, or partial fixes. The agent must autonomously perform implementation and verification.
- **`goal_complete` tool** — Without this, the agent would loop forever. The tool is described with `promptSnippet` and `promptGuidelines` so the LLM knows when to call it.
- **`terminate: true`** — The `goal_complete` tool returns `terminate: true`, which ends the current agent turn after the tool result is processed.
- **Confirmation on replacement** — Starting a new goal while one is active (and not complete) triggers a `ui.confirm()` dialog to prevent accidental replacement.
- **Legacy cleanup** — `/goal clear` attempts to clean up an old file-based state format (`~/.pi/agent/pi-goal-state.json`). Errors are silently ignored.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerCommand("goal")` | Registers the `/goal` slash command |
| `pi.registerTool("goal_complete")` | LLM-callable tool to signal goal completion |
| `pi.appendEntry("goal-state")` | Persists goal state to the session branch |
| `pi.sendUserMessage()` | Sends start, resume, and continuation prompts |
| `pi.on("before_agent_start")` | Injects goal system prompt into every agent turn |
| `pi.on("agent_end")` | Queues auto-continuation when goal is incomplete |
| `pi.on("message_end")` | Pauses goal on abort/error |
| `pi.on("turn_end")` | Tracks token usage delta |
| `pi.on("session_start")` | Reconstructs state from branch entries |
| `pi.on("session_shutdown")` | Persists final state |
| `pi.on("session_tree")` | Reconstructs state when navigating the tree |
| `pi.on("input")` | Cancels pending continuation on user input |
| `ctx.ui.setStatus()` | Shows 🎯 status line (active, paused, budget, complete) |
| `ctx.ui.confirm()` | Confirms goal replacement |
| `ctx.ui.notify()` | Status messages |
| `ctx.getContextUsage()` | Token usage tracking |

## Configuration

No flags. Token budget is set per-goal via `--tokens`.
