# Worker Model Extension

Selects one global model for delegated worker sessions (`agents` extension) and publishes the selection in Pi's status area. There is no hardcoded worker model: an unconfigured delegate fails with a descriptive error naming the config path.

## Usage

```
/worker-model                          # picker (all authenticated text models)
/worker-model provider/model-id        # set directly
/worker-model status                   # show the current selection
```

The agents extension resolves each delegate's model through `lib/worker-model.ts`: the `delegate` tool's `model` parameter wins, then this config, then `PI_WORKER_MODEL`. The special keyword `main` (as the delegate parameter) inherits the session model.

## How It Works

- **Config file**: `<agentDir>/worker-model.json` (override with `PI_WORKER_MODEL_CONFIG`), written atomically; `PI_WORKER_MODEL` env var overrides the file.
- **Status**: a `Worker Model` status entry and a grey `/ provider/model` segment in the status bar's editor meta line (alongside the small model), refreshed by a config-file watcher.
- **Picker**: same searchable model list as `/smallmodel`, filtered to authenticated text models.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerCommand("worker-model")` | Selection command |
| `pi.on("session_start")` | Publish status, start config watcher |
| `pi.on("session_shutdown")` | Stop watcher, clear status |
| `ctx.ui.setStatus()` / status-bar editor meta line | Display |

## Configuration

| Variable | Description |
|----------|-------------|
| `PI_WORKER_MODEL` | `provider/model-id`; overrides the config file (and disables `/worker-model` writes with a warning) |
| `PI_WORKER_MODEL_CONFIG` | Alternative config-file path |
