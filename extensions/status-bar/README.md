# Status Bar Extension

A Starship-inspired two-line footer plus an input editor wrapped in the same rounded accent modal frame the voice/handoff overlays use, with the model and thinking level shown in the title (top border).

## What It Does

Replaces Pi's default footer with a denser, more information-rich two-line status bar, and replaces the default input editor with one that draws a rounded accent modal frame around the prompt (the same `renderModalFrame` chrome as the voice/handoff overlays) and prints the current model and thinking level in the title (top border).

**Footer line 1** (static session info):
- Working directory (last path component)
- Gondolin workspace segment (`with WS <vm id>`) when a sandbox VM exists, between the cwd and the git branch — so line 1 reads like `pi-extensions with WS a1b2c3d4 on main`
- Git branch and a compact status block (`! ? + ✘ » = $ ↑ ↓ ⇕`) for ahead, behind, conflicted, stashed, deleted, renamed, modified, typechanged, staged, and untracked
- Right-aligned context usage bar with a token breakdown (`↑in ↓out ↗cache-read ↘cache-write`) and the turn count and cost

**Footer line 2** (transient events):
- Third-party extension statuses published via `ctx.ui.setStatus()`

Small- and worker-model labels live in the editor title and are omitted from the footer, so they are not shown twice. The Gondolin VM status is excluded too: the VM renders as the line 1 workspace segment, and a running goal is the **Goal** badge in the editor frame. Their `setStatus` entries remain as fallbacks for Pi's default footer.

The whole second line is omitted when there's nothing transient to show.

**Editor**:
- The input box is wrapped in the same rounded accent modal frame the voice/handoff overlays use (`renderModalFrame`), with side borders and padding
- The title (top border) shows the main model and its thinking level (color-coded per level), plus a flex badge when the model is flex-capable
- Configured small and worker models appear as grey, icon-labelled segments after the main model, separated by `/`
- While a goal is running, a **Goal** badge shows in the frame's top-right cell (same place as the **Plan Mode** badge, joined by a dim `·` when both are active)

## Usage

The status bar is on by default. To toggle it:

```
/statusbar:toggle
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

The editor is a `CustomEditor` subclass that overrides only `render()`. It renders the base editor at the modal's inner content width, strips the base editor's own top and bottom borders, and wraps the remaining content in the shared `renderModalFrame` chrome (rounded `╭╯` corners, `borderAccent` color, side `│` borders, padding). The title contains the main model, thinking level, optional flex badge, and configured small- and worker-model labels. The secondary labels use icons and grey `/` separators. The title is passed as `rawTitle` so its colored segments are not wrapped again. The frame's top-right cell shows **Plan Mode** (warning color) while plan mode is active and **Goal** while a goal is running, joined by a dim `·` when both apply. The extension reads both model configs on session start, refreshes them at the start of each turn, and watches their files. Changes from `/smallmodel`, `/worker-model`, or an external edit appear without waiting for the next turn. Autocomplete dropdown lines from the base editor remain below the box instead of being absorbed into the frame.

On `session_start` the extension captures whatever editor factory is currently registered (typically undefined, meaning Pi's default) and installs its own. On `session_shutdown` it restores the captured factory. `/statusbar:toggle` does the same swap, on demand.

The polished editor also re-checks on the next tick after `session_start` in case a later-loaded extension replaced the editor factory — if so, it re-installs.

### Footer and status indicator

The footer is registered through `ctx.ui.setFooter()`. While the extension is enabled, a Nerd Font dock-bottom icon with a muted `statusbar` label sits in the footer line 2 area, matching the cross-extension convention. `/statusbar:toggle` flips both at once.

## Key Design Decisions

- **Two lines, not one** — Static session info and transient events fight for the same real estate on a single line. Splitting them lets the right block (tokens, cost, bar) breathe on line 1 while third-party statuses live on line 2, omitted when empty.
- **No new state outside the session** — All state is per-instance and lives in the closure. No module-level mutation, no global map. The status bar extension is safe to load alongside others.
- **Editor captured, not overwritten** — The base editor factory is captured on install and restored on shutdown. If another extension (or Pi itself) replaces the editor, the polished one yields cleanly.
- **Modal chrome, shared with overlays** — The input box reuses `renderModalFrame` (rounded `borderAccent` corners, title in the top border) so it reads as the same family as the voice/handoff modals, instead of a one-off grey rule. Models and thinking live in the title, so the border never needs to track the thinking level.
- **Token breakdown always visible** — Hiding the breakdown when a bucket is empty makes the layout shift between turns. Showing zeros keeps the right block steady.
- **Tiered shedding on narrow terminals** — The right block is built in variants from fullest to emptiest. As the terminal narrows, cost and the bar are dropped before the static left block is ever truncated.
- **Editor re-checked after a tick** — A later-loaded extension can replace the editor factory during `session_start`. A short re-check after the synchronous install catches that race.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerCommand("statusbar:toggle")` | The toggle command |
| `pi.on("session_start")` | Initializes state, installs the editor and footer, sets the status line |
| `pi.on("session_shutdown")` | Disposes the footer, restores the editor factory |
| `pi.on("turn_start")` | Increments the turn count |
| `pi.on("turn_end")` | Refreshes git status, accumulates token usage |
| `pi.on("message_end")` | Re-aggregates token usage after each assistant message |
| `pi.on("model_select")` | Re-renders the editor and footer when the model changes |
| `pi.on("thinking_level_select")` | Re-renders the editor and footer when the thinking level changes |
| `pi.exec("git", …)` | Reads the working tree's git status and stash state |
| `pi.getThinkingLevel()` | Reads the current thinking level for the editor title |
| `ctx.ui.setFooter(factory)` | Replaces Pi's default footer |
| `ctx.ui.setEditorComponent(factory)` | Replaces the input editor |
| `ctx.ui.getEditorComponent()` | Captures the base editor factory on install |
| `ctx.ui.setStatus(key, text)` | The persistent status indicator |
| `ctx.ui.theme.fg(color, text)` | Colors for icons, labels, and the editor title |
| `ctx.ui.notify(message, severity)` | Toggle on/off feedback |
| `ctx.sessionManager.getBranch()` | Walks the branch to sum token usage and cost |
| `ctx.cwd` | Working directory for git status and footer display |
| `ctx.getContextUsage()` | Token count and context window for the usage bar |
| `CustomEditor` from `@earendil-works/pi-coding-agent` | The base editor the polished version subclasses |

## Configuration

None. The status bar is on by default. Use `/statusbar:toggle` to toggle.
