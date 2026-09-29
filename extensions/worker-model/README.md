# Worker Model Extension

Selects one global model for delegated worker sessions (`workers` extension). The selection is enforced for every worker and appears in the input bar. There is no hardcoded worker model: an unconfigured spawn_worker fails with a descriptive error naming the config path.

## Usage

```
/worker-model                              # picker (all authenticated text models)
/worker-model provider/model-id high       # set model and thinking level
/worker-model thinking xhigh               # change only the thinking level
/worker-model status                       # show the current selection
```

The workers extension resolves every spawn_worker call through `lib/worker-model.ts`. `PI_WORKER_MODEL` wins over the saved config; individual spawn_worker calls cannot override either source. Worker thinking defaults to `high` when an older config has no level.

## How It Works

- **Config file**: `<agentDir>/worker-model.json` (override with `PI_WORKER_MODEL_CONFIG`), written atomically with `provider`, `model`, and `thinkingLevel`; `PI_WORKER_MODEL` overrides the file, with `PI_WORKER_MODEL_THINKING` supplying the thinking level in that case.
- **Display**: a grey `/ <icon> provider/model` segment on the status bar's editor meta line, right next to the small model (owned by the status-bar extension, which watches the config file).
- **Picker**: same searchable model list as `/smallmodel`, filtered to authenticated text models.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerCommand("worker-model")` | Selection and status command |
| `ctx.modelRegistry.getAvailable()` | Populate the authenticated text-model picker |
| `ctx.ui.notify()` | Report the current selection and configuration errors |

## Configuration

| Variable | Description |
|----------|-------------|
| `PI_WORKER_MODEL` | `provider/model-id`; overrides the config file and disables `/worker-model` (including `status`) with a warning |
| `PI_WORKER_MODEL_THINKING` | Thinking level used with `PI_WORKER_MODEL`; defaults to `high` |
| `PI_WORKER_MODEL_CONFIG` | Alternative config-file path |

Supported levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Pi clamps the configured level to what the selected model supports.
