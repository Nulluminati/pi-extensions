# Context Extension

Claude Code-style `/context` for Pi: a framed modal that shows what is consuming
the context window — system prompt with a per-file AGENTS.md/CLAUDE.md breakdown,
skills, active tool definitions, conversation messages, free space, and the
compaction reserve — plus session token/cost totals and the largest messages.

## What It Does

`/context` measures the current context window and renders it as a single
overlay. Two kinds of numbers appear:

- The headline **used** figure comes from `ctx.getContextUsage()` — the
  provider-reported usage from the last assistant response plus estimates for
  trailing messages.
- Every category row is an independent estimate using pi's chars/4 heuristic
  (`estimateTokens`), so rows read as relative sizes, not exact counts.

## Usage

```
/context
```

In a TUI session the breakdown opens in a framed modal (title "Context") sized
to 70% of the terminal width and up to 80% of its height, centered. The modal
closes on `esc`, `enter`, or `q`.

### What the modal shows

- **Model** — the selected model as `provider/id`.
- **Used** — tokens used out of the context window, with percentage, free
  tokens, and a segmented bar (system prompt, conversation, free space).
- **System prompt** — estimated size of the assembled prompt, with sub-rows:
  - **Context files** — each AGENTS.md/CLAUDE.md file with its own estimate, so
    one bloated file is visible at a glance (paths shortened to be cwd- or
    home-relative).
  - **Skills** — estimated size of skill descriptions (only descriptions load
    into the prompt).
  - **Tools** — estimated size of the active tool definitions (name,
    description, parameter schema) and how many tools are active.
- **Messages** — estimated size of all messages in the current branch, with an
  entry count.
- **Free space** — context window minus used tokens.
- **Compaction buffer** — tokens pi reserves for autocompact
  (`DEFAULT_COMPACTION_SETTINGS.reserveTokens`).
- **Largest messages** — the five biggest messages with role, a one-line
  preview, and estimated tokens.
- **Session totals** — summed provider usage for the session: input, output,
  cache reads, cache writes, and cost.

Without a TUI (print/json mode), the same breakdown is delivered as plain text
via a display-only session message instead of a modal. A message renderer hides
that block from the transcript on reload, since the numbers are only meaningful
in the moment they were requested.

## How It Works

1. `measureContext` runs synchronously: it reads `ctx.getContextUsage()`, the
   assembled system prompt, the system-prompt options (context files and
   skills), the active tool list, and the session branch.
2. Message estimates use pi's `estimateTokens` heuristic, which handles text,
   images, tool calls, and tool results. Session totals sum the `usage` field
   of assistant messages in the branch.
3. In TUI mode the lines render inside `renderModalFrame` from `lib/tui-frame.ts`
   with a body budget derived from the terminal height, so the bottom border and
   key hints are never clipped. Key hints come from `lib/ui-format.ts`.

## Key Design Decisions

- **Estimates, clearly labeled** — category rows are chars/4 estimates and are
  marked "est"; only the headline used figure is provider-reported. The modal
  and plain-text output both state this.
- **No state, no persistence** — the extension stores nothing and writes no
  files. Every `/context` invocation measures fresh.
- **Hidden transcript block** — the non-TUI message uses a custom type whose
  renderer returns nothing, so print/json output never persists as a large
  block on session reload.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerCommand("context")` | Registers the `/context` command |
| `pi.registerMessageRenderer("context")` | Hides stale breakdown blocks from the transcript on reload |
| `pi.sendMessage(..., { triggerTurn: false })` | Delivers the plain-text breakdown when no TUI is available |
| `ctx.ui.custom(...)` | Shows the framed modal overlay |
| `ctx.getContextUsage()` | Provider-reported used tokens, percent, and context window |
| `ctx.getSystemPrompt()` / `ctx.getSystemPromptOptions()` | System prompt size, context files, and skills |
| `pi.getActiveTools() / pi.getAllTools()` | Active tool definitions for the Tools row |
| `ctx.sessionManager.getBranch()` | Branch messages for estimates and session totals |

## Configuration

None. The extension has no flags, environment variables, or config files.
