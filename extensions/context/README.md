# Context Extension

Claude Code-style `/context` for Pi: a framed modal that shows what is consuming
the context window — the system prompt with a per-part breakdown (base prompt,
per-file AGENTS.md/CLAUDE.md sizes, skills section), the tool schemas sent as
the API tools parameter, conversation messages, free space, and the compaction
reserve — plus session token/cost totals and the largest messages.

## What It Does

`/context` measures the current context window and renders it as a single
overlay. Two kinds of numbers appear:

- The headline **used** figure comes from `ctx.getContextUsage()` — the
  provider-reported usage from the last assistant response plus estimates for
  trailing messages.
- Category rows use pi's chars/4 heuristic (`estimateTokens`). The system
  prompt parent is measured from the assembled prompt; its sub-rows are cut
  from the same cloth and sum to the parent. Tool schemas are measured
  separately because pi sends them as the API `tools` parameter, not inside
  the prompt text. Rows read as relative sizes, not exact counts.

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
- **System prompt** — estimated size of the assembled prompt, with sub-rows
  that sum to it:
  - **Base prompt** — the remainder after the embedded parts: preamble, rules,
    docs, tool snippets, and cwd. Shown only when other sub-rows exist.
  - **Context files** — each AGENTS.md/CLAUDE.md file with its own estimate, so
    one bloated file is visible at a glance (paths shortened to be cwd- or
    home-relative).
  - **Skills** — estimated size of the skills section exactly as pi embeds it:
    names, descriptions, file paths, and XML markup. Pi only embeds the
    section when a read or bash tool is active.
- **Tools** — estimated size of the active tool definitions (name,
  description, parameter schema) and how many tools are active. Pi sends
  these as the API `tools` parameter, outside the prompt text, so the row is
  a sibling of the system prompt rather than a sub-row.
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
   images, tool calls, and tool results. Skills are measured with pi's own
   `formatSkillsForPrompt` so the row matches the embedded section. Session
   totals sum the `usage` field of assistant messages in the branch.
3. In TUI mode the lines render inside `renderModalFrame` from `lib/tui-frame.ts`
   with a body budget derived from the terminal height, so the bottom border and
   key hints are never clipped. Key hints come from `lib/ui-format.ts`.

## Key Design Decisions

- **Estimates, clearly labeled** — category rows are chars/4 estimates and are
  marked "est"; only the headline used figure is provider-reported. The modal
  and plain-text output both state this. The system prompt sub-rows sum to
  the parent by construction (base prompt is the remainder, clamped at zero).
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
