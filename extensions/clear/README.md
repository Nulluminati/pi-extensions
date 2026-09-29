# Clear Alias Extension

Aliases `/clear` to Pi's built-in `/new` command, for users whose muscle memory types `clear` to start a fresh session (Claude Code, terminal `clear`, and many CLIs all use it).

## What It Does

Registers `/clear` as a shortcut to `ctx.newSession()`. Both commands stay registered. In a user interface, `/clear` asks for confirmation before it starts a new session. Pi may also show its own confirmation when the current branch has content.

## Usage

```
/clear
```

That's it. The session resets and the editor is ready for a new prompt.

## How It Works

The extension calls `registerCommand("clear", …)` and uses `confirmModal` when a user interface is available. Then it calls `ctx.newSession()`. There is no state, config, or event handler.

## Key Design Decisions

- **Single command** — `/clear` starts a new session after confirmation in a user interface.
- **No state** — The extension stores no session data.
- **Confirm first** — `confirmModal` shows a framed dialog in the terminal. It falls back to `ctx.ui.confirm` outside terminal mode. Pi may show a second confirmation during `ctx.newSession()`.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerCommand("clear")` | The `/clear` slash command |
| `ctx.newSession()` | The behavior the alias delegates to |

## Configuration

None.
