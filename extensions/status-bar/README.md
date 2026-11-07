# Status Bar Extension

A responsive panel footer plus a rounded input editor. The editor title shows the model and thinking level.

## What It Does

Replaces Pi's default footer with rounded panels, inspired by [Pi Panels](https://github.com/alasano/house-of-pi/tree/master/packages/pi-panels).

| Panel | Information |
|-------|-------------|
| Workspace | Working directory basename, Git branch, and compact Git status indicators (`! ? + ✘ » = $ ↑ ↓ ⇕`) |
| Context | Context usage bar, tokens/context-window ratio, and token breakdown (`↑in ↓out ↗cache-read ↘cache-write`) |
| Session | Turn count, session cost, unread mail, and delegated-worker cost and tokens |

Panels sit beside each other when their contents fit. They share unused width evenly, so the panel row fills the terminal.
Otherwise, they stack and wrap their contents.
Frames use muted theme colors. Existing colors distinguish Git state, context thresholds, token types, mail, and costs.
Third-party extension statuses from `ctx.ui.setStatus()` appear below the panels. Long statuses wrap within the footer's height limit.

Small- and worker-model labels live in the editor title and are omitted from the footer, so they are not shown twice. Their `setStatus` entries remain as fallbacks for Pi's default footer.

The footer omits transient rows when no third-party status exists.

**Editor**:
- The input box is wrapped in the same rounded accent modal frame the handoff overlay uses (`renderModalFrame`), with side borders and padding
- The title (top border) shows the main model and its thinking level (color-coded per level), plus a flex badge when the model is flex-capable
- Configured small and worker models appear as grey, icon-labelled segments after the main model, separated by `/`
- While main-session Jev review is off, an **Approval Mode off** badge shows in the frame's top-right cell

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

The Context panel shows the usage bar, `tokens/contextWindow` ratio, and token breakdown. The Session panel shows turns and costs separately.
Narrow terminals stack the panels and wrap rows when enough screen rows remain.
Below 12 columns, the footer omits frames and wraps raw contents.

### Footer height

The footer uses at most half the terminal rows and leaves at least six rows outside it for the editor.
It reads the current terminal height on every render, so resizing updates the limit immediately.
If frames cannot fit, the footer uses compact labelled rows and truncates long values with `…`.
If content still exceeds the limit, the last row shows `↓ N more lines` instead of the excess rows.
Terminals with six or fewer rows show no footer. Taller terminals restore content without changing session state.

### Editor

The editor is a `CustomEditor` subclass that overrides only `render()`. It renders the base editor at the modal's inner content width, strips the base editor's own top and bottom borders, and wraps the remaining content in the shared `renderModalFrame` chrome (rounded `╭╯` corners, `borderAccent` color, side `│` borders, padding). The title contains the main model, thinking level, optional flex badge, and configured small- and worker-model labels. The secondary labels use icons and grey `/` separators. The title is passed as `rawTitle` so its colored segments are not wrapped again. The frame's top-right cell shows **Approval Mode off** (warning color) while main-session Jev review is disabled. The extension reads both model configs on session start, refreshes them at the start of each turn, and watches their files. Changes from `/smallmodel`, `/worker-model`, or an external edit appear without waiting for the next turn. Autocomplete dropdown lines from the base editor remain below the box instead of being absorbed into the frame.

On `session_start` the extension wraps the currently registered editor factory with `installEditorFactoryLayer` (layer id `status-bar`, priority 0) and registers the layered factory. On `session_shutdown` it removes that layer with `removeEditorFactoryLayer`, which unwraps back to the factory underneath. `/statusbar:toggle` performs the same install and remove, on demand.

The install also re-checks on the next tick after `session_start` in case a later-loaded extension replaced the editor factory. If the `status-bar` layer is no longer present, the extension deliberately re-installs its layer over the newcomer so the frame stays in place.

### Footer and status indicator

The extension registers the footer through `ctx.ui.setFooter()` and publishes its fallback `statusbar` indicator through `ctx.ui.setStatus()`.
The custom footer suppresses that indicator to avoid duplicate information. `/statusbar:toggle` controls the footer and editor together.

## Key Design Decisions

- **Full-width panels** — Each panel keeps enough width for its contents. Panels share spare columns evenly and align their frames.
- **No new state outside the session** — Footer and status state is per-instance and lives in the closure. The one deliberate exception is the editor's prompt-history store: a process-global map keyed by `Symbol.for("status-bar.prompt-history-by-session")` on `globalThis`, so submitted prompts survive editor re-creation within a session. The status bar extension is safe to load alongside others.
- **Editor layered, not overwritten** — The polished editor is a named `installEditorFactoryLayer` layer over whatever factory is registered; `removeEditorFactoryLayer` unwraps it on shutdown without disturbing other layers. If a later-loaded extension replaces the factory after `session_start`, the 0-tick re-check re-installs the layer.
- **Modal chrome, shared with overlays** — The input box reuses `renderModalFrame` (rounded `borderAccent` corners, title in the top border) so it reads as the same family as the handoff modal, instead of a one-off grey rule. Models and thinking live in the title, so the border never needs to track the thinking level.
- **Stable token indicators** — Empty buckets show zero. The height limit can collapse rows on short terminals.
- **Editor space first** — Narrow layouts stack when space permits. Short layouts remove frames before content and show an overflow count.
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
