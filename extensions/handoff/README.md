# Handoff Extension

Summarize the current session into a compact continuation prompt, then open a new Pi session with that prompt pre-filled in the editor.

## What It Does

Long sessions run out of context. Handoff reads the current branch, asks the global small model to condense it into a continuation prompt, lets you edit the result, and starts a new session with that prompt in the editor. The new session is parented to the old one.

## Usage

### Hand off to a new session

```
/handoff finish the auth refactor and add tests
```

The model is asked to produce a continuation prompt. You see a "Generating handoff summary…" status line while it works, then the editor opens with the result for review. Press Enter to send, or edit first.

### No goal yet

```
/handoff
```

If you don't pass a goal, the command opens an input dialog: "What should the new session focus on?" Type a one-line goal and confirm.

The goal is used to steer the summary (it tells the model what the next session should pick up) and to name the new session.

## How It Works

### Summary generation

1. **Transcript build** — Walks backward through the current branch and extracts the most recent user text, assistant text, and tool results until the transcript reaches its size limit. Each segment is bounded (a couple thousand characters for messages, a few hundred for tool results) so the input stays in a predictable size range.
2. **Goal and transcript sent to the model** — `completeSimple` from `@earendil-works/pi-ai` is called with a system prompt that asks for a concise continuation prompt: original request, what's done, key decisions, files touched, what remains, concrete next steps. No greetings, no code fences, no meta-commentary.
3. **Output validation** — Empty or unparseable responses surface as a notification; the handoff is cancelled.

### Review and edit

The summary is shown in `ctx.ui.editor("Review handoff prompt", summary)`. The user can rewrite, trim, or cancel. Cancellation surfaces a notification and the original session is untouched.

### New session

`ctx.newSession()` opens a fresh session with the edited summary pre-filled in its editor. Its `setup` callback names the session before the switch, and its `withSession` callback displays the "Handoff ready" notification through the replacement context. The current session's file path is passed as `parentSession` so the lineage is recorded.

The new session name comes from the goal, capitalized and truncated for display.

### Status indicator

While the summary is generating, a Nerd Font swap icon with a "Generating handoff summary…" label is shown in the status bar. It clears when generation finishes or fails.

## Key Design Decisions

- **Goal-guided summary** — The next-session goal is part of the LLM prompt, not just metadata. A good summary needs to know what it's summarizing *toward*.
- **Editable output, not auto-sent** — The user reviews the summary before the new session opens. Auto-sending would lose the chance to correct a confused model.
- **`completeSimple`, not `complete`** — The summary doesn't need streaming, tool calls, or full message construction. The simpler API is enough and avoids extra payload.
- **Bounded transcript** — The source branch is summarized, not copied. Without bounds, a long session would blow the model's input window and produce a worse summary.
- **Parent session recorded** — Linking the new session back to the old one keeps the conversation graph intact for later inspection.
- **No new state, no persistence** — Handoff is a single command. There's nothing to reconstruct on reload, so it stays stateless.
- **Goal length guard** — A goal beyond a few thousand characters is rejected with a notification. Beyond that, the LLM is the wrong tool — point to a file instead.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerCommand("handoff")` | The `/handoff` slash command |
| `ctx.newSession({ parentSession, setup, withSession })` | Opens and names a parented session, then pre-fills its editor through the replacement context |
| `ctx.ui.input(prompt, placeholder)` | Collects the goal when none is passed on the command line |
| `ctx.ui.editor(title, text)` | The review/edit step for the generated summary |
| `ctx.ui.setStatus(key, text)` | The "Generating handoff summary…" status line |
| `ctx.ui.notify(message, severity)` | Errors, cancellation, and the replacement-session ready notification |
| `ctx.ui.theme.fg(color, text)` | Colors the status icon and label |
| `ctx.modelRegistry.find()` / `getApiKeyAndHeaders()` | Resolves the global small model and its credentials |
| `ctx.sessionManager.getBranch()` / `getSessionFile()` | Reads the transcript and parents the new session |
| `completeSimple()` from `@earendil-works/pi-ai` | The LLM call that produces the summary |

## Configuration

Set the shared model with `/small-model`. Handoff stops with an error if that model is missing or unauthenticated; it does not fall back to the active chat model.
