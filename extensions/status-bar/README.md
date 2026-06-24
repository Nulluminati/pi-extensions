# Status Bar Extension

A Starship-inspired two-line footer plus a polished input editor that wraps the prompt in a neutral grey frame with the model and thinking level shown inside.

## What It Does

Replaces Pi's default footer with a denser, more information-rich two-line status bar, and replaces the default input editor with one that draws a grey frame around the prompt and prints the current model and thinking level on a metadata line inside the frame.

**Footer line 1** (static session info):
- Working directory (last path component)
- Git branch and a compact status block (`! ? + ✘ » = $ ↑ ↓ ⇕`) for ahead, behind, conflicted, stashed, deleted, renamed, modified, typechanged, staged, and untracked
- Right-aligned context usage bar with a token breakdown (`↑in ↓out ↗cache-read ↘cache-write`) and the turn count and cost

**Footer line 2** (transient events):
- Active and completed tool progress (`⚙ toolname ✓N`)
- Third-party extension statuses published via `ctx.ui.setStatus()`

The whole second line is omitted when there's nothing transient to show.

**Editor**:
- The input box is wrapped in a neutral grey frame held constant so it never tracks the thinking level
- A metadata line inside the frame shows the model and thinking level (color-coded per level)

## Usage

The status bar is on by default. To toggle it:

```
/statusbar
```

Disabling restores Pi's default footer and editor; re-enabling brings the polished versions back.

## How It Works

### State

The extension holds its state in a per-instance object (no module-level mutation). On `session_start` it zeroes the turn count and token usage, captures the current working directory, and subscribes to branch changes so the footer re-renders when you switch branches.

### Git status

`session_start` and `turn_end` trigger a `git status --porcelain=2 --branch` and a `git rev-parse --verify --quiet refs/stash` in the project root. The output is parsed into a small struct: ahead/behind counts, conflicted, untracked, modified, staged, renamed, deleted, typechanged, and whether a stash exists. The footer renders this as a single bracketed block (e.g. `[!+] ↑1`).

### Token accumulation

On every `message_end` and `turn_end` the extension walks the current branch and sums `input`, `output`, `cacheRead`, `cacheWrite`, and `cost` across assistant messages. The four token indicators are always shown — they read `0` at session start and grow as the conversation does. Cost is shown to three decimals, so a fresh session reads `$0.000`.

### Context usage bar

The right block has a usage bar, a `tokens/contextWindow` ratio, the token breakdown, the turn count, and cost. When the terminal is narrow, the right block is shed in tiers (cost first, then the bar, then the window) so the static left block wins and the token counts stay visible as long as possible.

### Editor

The editor is a `CustomEditor` subclass that overrides only `render()`. The base editor draws its borders and content; the polished version strips the top and bottom borders, surrounds the content with a fixed-grey frame, and inserts a metadata line (model + thinking level) above the bottom border. Autocomplete dropdown lines from the base editor are preserved below the bottom border instead of being absorbed into the frame.

On `session_start` the extension captures whatever editor factory is currently registered (typically undefined, meaning Pi's default) and installs its own. On `session_shutdown` it restores the captured factory. `/statusbar` does the same swap, on demand.

The polished editor also re-checks on the next tick after `session_start` in case a later-loaded extension replaced the editor factory — if so, it re-installs.

### Footer and status indicator

The footer is registered through `ctx.ui.setFooter()`. While the extension is enabled, a Nerd Font dock-bottom icon with a muted `statusbar` label sits in the footer line 2 area, matching the cross-extension convention. `/statusbar` flips both at once.

## Key Design Decisions

- **Two lines, not one** — Static session info and transient events fight for the same real estate on a single line. Splitting them lets the right block (tokens, cost, bar) breathe on line 1 while in-flight tool progress and third-party statuses live on line 2, omitted when empty.
- **No new state outside the session** — All state is per-instance and lives in the closure. No module-level mutation, no global map. The status bar extension is safe to load alongside others.
- **Editor captured, not overwritten** — The base editor factory is captured on install and restored on shutdown. If another extension (or Pi itself) replaces the editor, the polished one yields cleanly.
- **Frame color is fixed, not themed** — The frame is held at a constant muted border hue regardless of thinking level or model. Following the thinking-level border would make the box flash on level change; static grey reads as a stable chrome.
- **Token breakdown always visible** — Hiding the breakdown when a bucket is empty makes the layout shift between turns. Showing zeros keeps the right block steady.
- **Tiered shedding on narrow terminals** — The right block is built in variants from fullest to emptiest. As the terminal narrows, cost and the bar are dropped before the static left block is ever truncated.
- **Editor re-checked after a tick** — A later-loaded extension can replace the editor factory during `session_start`. A short re-check after the synchronous install catches that race.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerCommand("statusbar")` | The toggle command |
| `pi.on("session_start")` | Initializes state, installs the editor and footer, sets the status line |
| `pi.on("session_shutdown")` | Disposes the footer, restores the editor factory |
| `pi.on("turn_start")` | Increments the turn count, clears active tool list |
| `pi.on("turn_end")` | Refreshes git status, accumulates token usage |
| `pi.on("message_end")` | Re-aggregates token usage after each assistant message |
| `pi.on("model_select")` | Re-renders the editor and footer when the model changes |
| `pi.on("thinking_level_select")` | Re-renders the editor and footer when the thinking level changes |
| `pi.on("tool_execution_start")` | Tracks active tool executions |
| `pi.on("tool_execution_end")` | Removes completed tools, increments the completed count |
| `pi.exec("git", …)` | Reads the working tree's git status and stash state |
| `pi.getThinkingLevel()` | Reads the current thinking level for the editor metadata line |
| `ctx.ui.setFooter(factory)` | Replaces Pi's default footer |
| `ctx.ui.setEditorComponent(factory)` | Replaces the input editor |
| `ctx.ui.getEditorComponent()` | Captures the base editor factory on install |
| `ctx.ui.setStatus(key, text)` | The persistent status indicator |
| `ctx.ui.theme.fg(color, text)` | Colors for icons, labels, and the metadata line |
| `ctx.ui.notify(message, severity)` | Toggle on/off feedback |
| `ctx.sessionManager.getBranch()` | Walks the branch to sum token usage and cost |
| `ctx.cwd` | Working directory for git status and footer display |
| `ctx.getContextUsage()` | Token count and context window for the usage bar |
| `CustomEditor` from `@earendil-works/pi-coding-agent` | The base editor the polished version subclasses |

## Configuration

None. The status bar is on by default. Use `/statusbar` to toggle.
