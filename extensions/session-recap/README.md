# Session Recap Extension

Shows a one-line recap above the editor when you refocus a Pi session or after idle time, so you can re-enter flow without re-reading scrollback.

## What It Does

When you switch away from your Pi terminal and come back, or after the agent has been idle for a while, this extension generates a terse one-line summary of what the agent just did. The recap appears as a widget above the editor area and disappears as soon as you start typing.

This is inspired by Claude Code's session recap feature — it helps you quickly orient yourself after context switching.

## Usage

### Manual recap

```
/recap
```

Force-generates a recap of recent session activity right now. A manual recap wins over automatic triggers: idle/focus generations yield to an in-flight `/recap` instead of aborting it. When there is nothing to recap yet, `/recap` says so instead of failing silently.

### Automatic recap

The extension generates recaps automatically in three scenarios:

1. **Focus reporting** — When your terminal loses focus (you switch to another window/app), a recap is drafted in the background. When you switch back, if you were away for at least 3 seconds, the recap is revealed. Quick glances (< 3 seconds) are ignored.
2. **Idle fallback** — After each `turn_end`, a timer starts (default 45 seconds). If no new activity occurs, a recap is generated.
3. **Session resume/fork** — When Pi starts with `reason: "resume"` or `"fork"`, a recap is generated after a 300ms delay to summarize where the prior session left off.

## How It Works

### Recap generation

1. **Context extraction** — Reads the session branch and builds a text transcript from the last user message onward. Includes user text, assistant text, tool calls (with truncated arguments), and tool results. The prompt carries at most 12000 characters of transcript. When the text is longer, whole lines are dropped from the front so the newest steps always reach the model; a `[earlier transcript omitted]` marker shows where the cut starts.
2. **Meaningful activity check** — Only generates a recap if the transcript contains at least 50 assistant words or 1+ tool call after the last user message. This prevents empty/empty-looking recaps.
3. **LLM call** — Uses `completeSimple()` from `@earendil-works/pi-ai` with a dedicated system prompt ("You write terse, concrete session recaps for a coding agent UI."). The prompt instructs the model to produce exactly one line in the format: `recap: <what happened, past tense, concrete>. Next: <one-line next step>.`
4. **Display** — The recap is published through the shared widget strip (`setStripWidget` with `WIDGET_PRIORITY_RECAP`), which pins it above the other strip widgets (workers, jobs, todos, missions, autoresearch). A `recap:changed` event is still emitted on the shared `pi.events` bus for external consumers.

### Focus reporting (DECSET ?1004)

The extension uses terminal focus reporting to detect when you switch away from and back to the Pi terminal:

- **Enable** — On `session_start`, if TTY is available, writes `\x1b[?1004h` to stdout to enable focus reporting. The extension skips this step when `--recap-disable` or `--recap-disable-focus` is set, or when the session has no UI
- **Listen** — Attaches a `data` listener on `process.stdin` that scans for `\x1b[I` (focus in) and `\x1b[O` (focus out) escape sequences
- **Disable** — On `session_shutdown`, writes `\x1b[?1004l` and removes the listener

The focus listener uses a small buffer to handle partial sequences and processes sequences byte-by-byte to avoid false positives.

### Deferred focus recaps

If focus-out occurs while the agent is actively running (and `--recap-during-active` is not set), the recap is deferred. When `agent_end` fires, the deferred recap is generated. This prevents generating a recap mid-turn.

### Cancellation and cleanup

- **User input** — Clears any displayed recap and cancels pending idle timers and active LLM requests
- **Turn start** — Cancels idle timers and active LLM requests
- **Agent start** — Clears displayed recap and cancels pending work
- **Branch navigation** — If the last message entry changes during recap generation, the result is discarded

### Per-instance state (WeakMap)

All state is stored in a `WeakMap<ExtensionAPI, RecapState>` with the following fields:

| Field | Purpose |
|-------|---------|
| `idleTimer` | `setTimeout` handle for idle recap |
| `activeController` | `AbortController` for the in-flight LLM request |
| `activeReason` | Which trigger ("idle", "manual", "resume", "focus") started the current request |
| `agentActive` | Whether an agent turn is currently running |
| `focusDraftAfterAgent` | Whether a focus-out occurred during an active agent turn |
| `focusListener` | The `stdin` data listener for focus reporting |
| `focusEnabled` | Whether DECSET ?1004 has been enabled |
| `focusedOutAt` | Timestamp of the last focus-out event |
| `pendingRecap` | A recap drafted during focus-out, waiting to be shown on focus-in |
| `lastDraftedLeafId` | The session leaf ID when the last recap was drafted (prevents duplicate recaps) |
| `autoDismissTimer` | `setTimeout` handle that auto-dismisses the visible recap after 120 seconds |

## Key Design Decisions

- **One-line format** — The recap is intentionally terse (~220 chars max). It's meant to orient you, not replace reading the scrollback.
- **Widget, not notification** — The recap publishes through the shared widget strip (`setStripWidget`) so it sits above the editor, visible but unobtrusive. It clears on the next user input, or auto-dismisses after 120 seconds.
- **AbortController for LLM calls** — If a new recap request starts before the old one finishes, the old one is aborted. This prevents stale recaps from appearing. Exception: automatic triggers (idle, focus) never abort an in-flight `/recap` — slash commands run before the `input` event, so the idle timer can still be armed when `/recap` starts.
- **`completeSimple()`** — Uses the simpler API instead of `complete()` because recaps don't need streaming, tool calls, or complex payload construction.
- **Cache retention: "none"** — Recaps are ephemeral and should not be cached by the provider.
- **Max tokens: 256** — Caps the LLM response to prevent long rambling recaps.
- **Prompt budget keeps the tail** — The recap prompt holds the last 12000 characters of transcript, not the first. A long turn or a resumed session can then name the step that just happened instead of the step it started with.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerCommand("recap")` | Manual `/recap` command |
| `pi.registerFlag()` | Configuration flags for idle time, focus min, disable, etc. |
| `pi.on("turn_end")` | Schedules idle recap timer |
| `pi.on("turn_start")` | Cancels idle timer and active requests |
| `pi.on("input")` | Clears displayed recap and cancels pending work |
| `pi.on("agent_start")` | Tracks agent active state |
| `pi.on("agent_end")` | Generates deferred focus recaps |
| `pi.on("session_start")` | Attaches focus reporting, generates resume/fork recaps |
| `pi.on("session_shutdown")` | Detaches focus reporting and clears state |
| `pi.getFlag()` | Reads configuration flags at runtime |
| `setStripWidget()` (`lib/widget-strip.ts`) | Displays/clears the recap widget at `WIDGET_PRIORITY_RECAP` |
| `pi.events.emit("recap:changed")` | Notifies external consumers when the recap appears or clears (strip priority now keeps the recap above sibling widgets) |
| `ctx.ui.theme.fg()` | Styles the recap header with accent color |
| `ctx.sessionManager.getBranch()` | Extracts conversation transcript |
| `ctx.sessionManager.getLeafId()` | Detects branch navigation during generation |
| `ctx.modelRegistry.find()` / `getApiKeyAndHeaders()` | Resolves the global small model and its credentials |
| `completeSimple()` from `@earendil-works/pi-ai` | Generates the recap text |

## Configuration

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--recap-idle-seconds` | string | `45` | Seconds after `turn_end` before the idle recap is generated |
| `--recap-focus-min-seconds` | string | `3` | Minimum focus-out duration (seconds) before showing a recap on refocus |
| `--recap-disable-focus` | boolean | `false` | Disable DECSET ?1004 focus reporting (idle fallback still runs) |
| `--recap-during-active` | boolean | `false` | Allow focus-triggered recaps while an agent turn is still running |
| `--recap-disable` | boolean | `false` | Disable the automatic session recap entirely |

Set the recap model with `/smallmodel`. Recap generation does not fall back to the active chat model.

Example:

```bash
pi --recap-idle-seconds 30
```
