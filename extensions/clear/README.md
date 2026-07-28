# Clear Alias Extension

Aliases `/clear` to Pi's built-in `/new` command, for users whose muscle memory types `clear` to start a fresh session (Claude Code, terminal `clear`, and many CLIs all use it).

## What It Does

Registers a single slash command — `/clear` — that behaves exactly like `/new`. Both commands stay registered; this extension does not unregister anything. The discard confirmation (when the current branch has content) is handled by the underlying `/new` behavior.

## Usage

```
/clear
```

That's it. The session resets and the editor is ready for a new prompt.

## How It Works

The extension calls `registerCommand("clear", …)` with a handler that asks for confirmation (in UI mode) and then delegates to `ctx.newSession()`. There's no state, no config, and no event handlers.

## Key Design Decisions

- **Single responsibility** — One command, one line of behavior. Anything more belongs in `/new`'s own logic, not in a shim.
- **No state, no overrides** — Any future `/new` semantics are inherited automatically because this extension just calls through.
- **Confirm first** — Ending the current session is destructive, so the handler runs `ctx.ui.confirm()` before calling through. The extra confirmation from the underlying `/new` behavior is unchanged.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerCommand("clear")` | The `/clear` slash command |
| `ctx.newSession()` | The behavior the alias delegates to |

## Configuration

None.
