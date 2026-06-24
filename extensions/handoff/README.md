# Handoff Extension

Summarize the current session into a compact continuation prompt, then open a new Pi session with that prompt pre-filled in the editor.

## What It Does

Long sessions run out of context. Handoff gives you a clean exit: it reads your current branch, asks the active model to condense it into a tight prompt that captures the goal, what's done, and what's next, lets you review and edit the result, and starts a new session with that prompt already in the editor. The new session is parented to the old one, so the lineage is preserved.

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

1. **Transcript build** — Walks the current branch and extracts user text, assistant text, and tool results into a compact transcript. Each segment is bounded (a couple thousand characters for messages, a few hundred for tool results) so the input stays in a predictable size range.
2. **Goal and transcript sent to the model** — `completeSimple` from `@earendil-works/pi-ai` is called with a system prompt that asks for a concise continuation prompt: original request, what's done, key decisions, files touched, what remains, concrete next steps. No greetings, no code fences, no meta-commentary.
3. **Output validation** — Empty or unparseable responses surface as a notification; the handoff is cancelled.

### Review and edit

The summary is shown in `ctx.ui.editor("Review handoff prompt", summary)`. The user can rewrite, trim, or cancel. Cancellation surfaces a notification and the original session is untouched.

### New session

`ctx.newSession()` opens a fresh session with the edited summary pre-filled in its editor. The `withSession` callback also drops a "Handoff ready" notification in the new context. The current session's file path is passed as `parentSession` so the lineage is recorded.

The new session is named from the goal (capitalized, truncated for display). A final "Handoff complete" notification names it.

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
| `pi.setSessionName(name)` | Names the new session from the goal |
| `ctx.newSession({ parentSession, withSession })` | Opens a new session, parents it to the current one, and pre-fills the editor |
| `ctx.ui.input(prompt, placeholder)` | Collects the goal when none is passed on the command line |
| `ctx.ui.editor(title, text)` | The review/edit step for the generated summary |
| `ctx.ui.setStatus(key, text)` | The "Generating handoff summary…" status line |
| `ctx.ui.notify(message, severity)` | Errors, cancellation, and completion notifications |
| `ctx.ui.theme.fg(color, text)` | Colors the status icon and label |
| `ctx.model` / `ctx.modelRegistry.getApiKeyAndHeaders()` | Resolves the active model and its credentials |
| `ctx.sessionManager.getBranch()` / `getSessionFile()` | Reads the transcript and parents the new session |
| `completeSimple()` from `@earendil-works/pi-ai` | The LLM call that produces the summary |

## Configuration

None. The extension reads whatever model is active and uses its credentials.
