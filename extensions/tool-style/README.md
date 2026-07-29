# Tool Style Extension

Gives Pi's input-area execution blocks one shared surface and a thin, state-colored left rail without replacing their execution logic.

## What It Styles

- Agent tool calls, including tools that provide their own shell
- Direct `!command` output
- Standard extension message boxes

The extension reserves one terminal column and draws `▏` along the left edge. The first spacer row remains empty so consecutive blocks keep Pi's normal vertical rhythm.

Direct commands keep Pi's command header, streaming output, cancellation, truncation, expansion, and exit status. Their top and bottom rules are removed so they use the same surface-and-rail shell as agent tools.

## Colors

Rails use semantic colors from the active Pi theme:

| Block | Rail color |
|---|---|
| Running agent tool | `accent` |
| Successful agent tool | `success` |
| Failed agent tool | `error` |
| Running direct command | `bashMode` |
| Cancelled direct command | `warning` |
| Extension message | `customMessageLabel` |

The surface comes from pywal's current terminal background in `~/.cache/wal/colors.json`. Each RGB channel is blended 25% toward black, which keeps the blocks darker than the surrounding terminal across theme changes. The extension watches the cache file and updates running Pi sessions when pywal writes a new palette.

No fixed RGB color is embedded. If the pywal cache is unavailable, Pi's configured tool and custom-message backgrounds remain in effect.

## Usage

The style is enabled when a TUI session starts. Toggle it without restarting Pi:

```text
/toolstyle:toggle
```

## How It Works

Pi does not currently expose a global tool-shell decorator. The extension narrowly wraps the exported `ToolExecutionComponent`, `BashExecutionComponent`, and `CustomMessageComponent` render methods. It also wraps the exported `Theme` background methods for tool and custom-message tokens only. Existing renderers still produce content, diffs, expansion behavior, and streaming updates.

Original render and theme methods are restored during `session_shutdown`. The pywal watcher is stopped at the same time. A repeated `session_start` replaces earlier wrappers and the watcher instead of stacking them.

## Compatibility

The component and theme classes are exported by Pi, but prototype wrapping is not a formal styling API. Pi upgrades that alter these classes may require an extension update. The automated tests cover color computation, state transitions, direct-command normalization, narrow terminals, live palette updates, toggling, repeated startup, and shutdown restoration.
