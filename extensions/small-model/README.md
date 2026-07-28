# Small Model Extension

Sets one global model for lightweight background tasks. Handoff summaries, BTW side turns and summaries, session recaps, and spoken voice summaries all use this model instead of the active chat model.

## Usage

Run `/smallmodel` to choose from the authenticated text models registered with Pi. Each row shows the model name, context window, output limit, image support, and reasoning support. Type in the search bar to filter by provider, model ID, or model name:

```text
/smallmodel
```

Set one directly, with an optional thinking level:

```text
/smallmodel synthetic/syn:small:text minimal
```

Show the current setting:

```text
/smallmodel status
```

The selection appears in the footer through `ctx.ui.setStatus()`. The bundled status bar displays it on its second line.

## Configuration

The command writes:

```text
~/.pi/agent/small-model.json
```

Example:

```json
{
  "provider": "synthetic",
  "model": "syn:small:text",
  "thinkingLevel": "minimal"
}
```

Supported thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Models that do not support reasoning ignore this field.

Set `PI_SMALL_MODEL` for a process-level override:

```bash
PI_SMALL_MODEL=synthetic/syn:small:text \
PI_SMALL_MODEL_THINKING=minimal \
pi
```

When `PI_SMALL_MODEL` is set, `/smallmodel` cannot replace it. Unset the variable first. `PI_SMALL_MODEL_CONFIG` can point at a different config file.

The extension watches the config directory. Changes made by another Pi process or a text editor update the status in running sessions.

## Failure behavior

Consumers do not fall back to the active chat model. A missing model or credential stops the background task and reports the configuration error. This prevents an expensive main model from being used silently.

## Pi APIs used

| API | Purpose |
|-----|---------|
| `pi.registerCommand("smallmodel")` | Global model picker and direct configuration |
| `pi.on("session_start")` | Publishes status and starts the config watcher |
| `pi.on("session_shutdown")` | Stops the watcher and clears status |
| `ctx.modelRegistry.getAvailable()` | Lists authenticated text models |
| `ctx.modelRegistry.find()` | Resolves the configured provider and model ID |
| `ctx.modelRegistry.getApiKeyAndHeaders()` | Validates credentials for consumers |
| `ctx.ui.setStatus()` | Shows the effective small model in the footer |
