# BTW Extension

A parallel side-conversation channel — ask "by the way" questions while the main agent works, then hand the result back when you're ready.

## What It Does

The `/btw` command opens a top-centered overlay window with its own tool-using side agent. While your main agent is in the middle of a task, you can ask quick side questions ("what file defines this route?", "what are the risks of optimistic updates here?", "remind me how this parser works") and get answers without interrupting the main work.

The side thread is hidden from the main agent's context by default. When you want the result, you can hand the whole thread back, or a condensed summary of it, as a follow-up to the main agent.

It's a second agent running in a parallel window. It can read files, run shell commands, and edit code just like the main one. It always uses the global small model, with an optional per-thread thinking override.

## Usage

### Open the side window

```
/btw
```

This opens the overlay. The current side thread is preserved (or started fresh if there is none). You can type a question into the composer and press Enter to send it. The side agent streams its answer in the overlay.

If you already know what you want to ask, pass it on the command line and the side turn starts immediately:

```
/btw what file defines the auth flow?
```

If you pass a question on the command line, the side turn starts immediately. Otherwise the overlay opens and you type into the composer.

### Continue vs start fresh

| Command | What it does |
|---------|--------------|
| `/btw` | Continue the current side thread. Doesn't reset anything. |
| `/btw "question"` | Open the overlay, ask the question immediately. |
| `/btw:new` | Wipe the side thread back to empty, then open the overlay. |
| `/btw:new "question"` | Wipe the side thread, open the overlay, ask the question. |
| `/btw:tangent` | Same as `/btw` but the side agent has **no** main-session context. Useful for brainstorming from first principles. Open it with no question to start a fresh tangent thread. |
| `/btw:clear` | Discard the side thread and close the overlay. |

### Hand the result back to the main agent

```
/btw:inject                       # hand the full thread verbatim
/btw:inject implement the recommended migration plan   # with instructions
/btw:summarize                    # hand a condensed summary instead
/btw:summarize use the answer to refactor the auth module
```

Inject pushes the full exchange (or your instructions plus the exchange) as a user message into the main agent. Summarize first distills the thread with a separate agent pass and hands the summary instead. Both clear the side thread afterwards.

If the main agent is currently busy, the injection is queued as a follow-up so it lands at the end of the current turn rather than interrupting mid-stream.

BTW uses the model selected by `/small-model`. It stops with an error if that model is unavailable rather than falling back to the active chat model.

### Adjust the thinking level for side questions

```
/btw:thinking                       # show current effective thinking level
/btw:thinking low                   # run the side agent at "low" thinking
/btw:thinking clear                 # back to inheriting the main thread
```

Useful when you want quick "look this up" answers without burning tokens on a deep thinking pass.

## Inside the Overlay

```
┌─────────────────────────────────────────────────┐
│ ● FOCUSED  BTW                                   │
│ contextual · anthropic/sonnet · thinking medium   │
├─────────────────────────────────────────────────┤
│ 2 exchanges · streaming                         │
├─────────────────────────────────────────────────┤
│ ▸ you: what file defines the auth flow?         │
│ ▸ btw: src/auth/flow.ts handles the login …     │
│   ↳ read(src/auth/flow.ts)                      │
│   ↳ result: import { Router } from "express"; … │
├─────────────────────────────────────────────────┤
│ ⏳ streaming…                                    │
│ › type your question here_                      │
│ enter · esc: dismiss · alt+/: focus · mouse/…  │
└─────────────────────────────────────────────────┘
```

- **Title** — `● FOCUSED` (green) when the overlay has keyboard focus, `○` (dim) when the editor does. Alt+`/` toggles between them.
- **Config** — the current mode, global small model, and effective thinking level.
- **Summary** — exchange count + streaming/idle state + scroll indicators.
- **Body** — the live transcript. User prompts, side-agent thinking (italic dim), tool calls (name + truncated args), and tool results (truncated with a marker when long). Errors are flagged.
- **Status** — what the side thread is doing right now.
- **Composer** — the platform's single-line `Input` widget. Type a question, press Enter to send. Press Esc to dismiss the overlay (the thread is preserved).
- **Hints** — keyboard shortcuts.

Mouse wheel, `↑`/`↓`, and `PgUp`/`PgDn` scroll the transcript. If the user scrolls up and new content arrives, the overlay follows the transcript again once the user scrolls back to the bottom.

## How It Works

### Side agent

The side agent is a real second agent, not just a one-off LLM call. It runs on its own session with the same coding toolset (read, bash, edit, write) so it can actually open files and run commands to answer your questions. The side session is seeded with main-session context if you started the thread in **contextual** mode (the default), or with no context if you used `/btw:tangent`.

The side agent is told it's in an aside conversation — main-session messages are for context only, that work is being handled by another agent. This keeps it from racing the main thread.

### Context isolation

On every agent turn, the extension's `on("context")` handler filters out anything that came from BTW:
- The side thread's exchanges (hidden `btw-thread` custom entries)

The main agent never sees the side conversation unless you explicitly inject or summarize it back.

### Two modes

- **Contextual** (default, `/btw`) — the side agent sees the main session's recent messages as background. Good for "what about X?" follow-ups.
- **Tangent** (`/btw:tangent`) — the side agent sees no main-session context. Good for brainstorming from first principles.

Switching modes clears the current thread so the two contexts never mix.

### Persistence

The side thread is hidden — not visible in the main transcript — but it's persisted to the session branch via `appendEntry("btw-thread", { state })`. On `session_start` and on branch navigation, the extension walks the branch backwards to find the most recent thread state and reconstructs it. The overlay reopens showing your saved conversation.

The `/btw:thinking` setting is stored with the thread, so it survives reloads and branch switches. Old thread entries that contain a model override still load, but the override is ignored.

### Hidden thread

The side thread stays hidden from the main agent unless you inject or summarize it. Both `/btw:inject` (full thread) and `/btw:summarize` (condensed) deliver the content to the main agent as a follow-up user message; nothing from the side channel reaches the main agent's context without an explicit handoff.

### Toggling focus

The overlay starts non-capturing, so the main editor keeps focus by default. Press `alt+/` to move focus into the overlay's composer; press it again to move back. This means you can keep typing in the main editor and the side window stays out of the way until you actually want to interact with it.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerCommand("btw", "btw:new", …)` | The seven user-facing slash commands |
| `pi.registerShortcut("alt+/", "ctrl+alt+w")` | Toggle focus between overlay and editor |
| `pi.on("context")` | Filters side-thread entries out of the main agent's context every turn |
| `pi.on("session_start")`, `on("session_tree")` | Reconstructs the side thread from the branch |
| `pi.on("session_shutdown")` | Tears down the live side session and the overlay |
| `pi.appendEntry("btw-thread")` | Persists the side thread to the session branch |
| `pi.appendEntry("btw-thread-reset")` | Marks a thread reset, so reconstruction starts after this point |
| `pi.sendUserMessage(content, { deliverAs: "followUp" })` | Hands the thread or summary back to the main agent (queued as a follow-up when busy) |
| `ctx.ui.custom(factory, { overlay: true, overlayOptions })` | Opens the side window as a real overlay |
| `ctx.ui.notify()` | Status messages, model errors, and warnings |
| `ctx.modelRegistry.find()` | Resolves the global small model |
| `ctx.modelRegistry.getApiKeyAndHeaders()` | Resolves credentials for the global small model |
| `ctx.getSystemPrompt()` | Seeds the side agent's system prompt |

## Key Design Decisions

- **Side agent is a real second agent, not a one-off completion.** A side question is often "look at this file and tell me…" — which needs tools. Running the side chat as a genuine second agent with the coding toolset is what makes it useful for coding work, and what enables a continuous multi-turn thread.
- **Hidden by default, explicit handoff.** Side chatter is the whole point of the channel — keeping it out of the main agent's context is the point. Threads persist as hidden entries and only reach the main agent when you explicitly inject or summarize them.
- **Two modes (contextual / tangent).** Most side questions are about the current work and want its context; pure brainstorming wants none of it. Switching modes clears the current thread so the two contexts never mix.
- **Shared small model, local thinking override.** Model selection stays consistent across lightweight tasks while each side thread can reduce or increase reasoning.
- **Inject vs summarize as two distinct handoffs.** Sometimes the exact wording of a plan matters (inject); sometimes only the conclusion does (summarize). Both are supported, both accept an optional leading instruction, both clear the thread afterwards.
- **Top-centered, non-capturing overlay.** Keeps the main session visible underneath and lets you toggle focus rather than trapping it. The main editor stays usable while the overlay is open.
- **Persistent but disposable live session.** The live side session is torn down on mode changes, dismiss, and shutdown, while the saved thread remains.

## Configuration

Set the shared model with `/small-model`. `/btw:thinking` can override its reasoning level for the current side thread; `/btw:thinking clear` returns to the global setting.
