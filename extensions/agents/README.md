# Agents Extension

Multi-agent workflows: delegate bounded, well-specified tasks to cheap-model worker Pi sessions. Every worker routes its built-in file and shell tools through a Gondolin VM and has its own context and messenger identity. Workers that can make changes also get an isolated git worktree and branch by default. The parent session is woken when a worker exits; reports and patches are collected explicitly.

## Usage

```text
delegate (task="Scout the auth subsystem: entry points, data flow, risks. Read-only.", isolate=false)
delegate (task="Replace all fmtAmount call sites with formatCurrency", isolate=true)
workers (action=list)
workers (action=status, id="w-...")
workers (action=collect, id="w-...")   # apply the worker's patch to the working tree
workers (action=cancel, id="w-...")
```

You will be woken when a worker exits; read its report with `workers (action=status)` and apply its patch with `action=collect`. Use `wait: true` for short read-only tasks when you want the report inline.

## How It Works

- **Worker sessions**: `pi --mode json --no-session --no-extensions --model <worker> --thinking <level> --gondolin -p <task>` with the required Gondolin and messenger extensions plus the configured extension set. The final assistant text becomes the worker's report.
- **Worktree isolation**: workers that can modify files branch from `HEAD` into `.pi/worktrees/<id>` on branch `agents/<id>`. The tree must be clean so the worker starts from an unambiguous base. On completion, committed changes, uncommitted changes, and new files are captured in a patch under `.pi/workers/patches/`. `collect` applies the patch to the main tree and removes the worktree only after confirming that the patch still exists. Plan-mode workers are read-only, inspect the current workspace through Gondolin, and do not create worktrees or patches.
- **Trusted wakes**: wake messages carry only ids and status words, never worker output — output is read on demand via the workers tool, so a worker's stdout is never injected as user-authored content.
- **Durable registry**: `.pi/workers/registry.json` survives restarts. Any read reconciles records stuck in `running` whose pid is dead (marked failed), so crashed parents leave no permanent ghosts and their concurrency slots are freed; on shutdown, running workers are cancelled (SIGTERM process group, then SIGKILL).
- **Runaway guards**: default max 4 concurrent workers (`PI_MAX_WORKERS`), hard per-worker timeout (`PI_WORKER_TIMEOUT_S`, default 900s), unique running names.

## Configuration

| Variable | Description |
|----------|-------------|
| `PI_WORKER_MODEL` | `provider/model-id` for every worker; wins over `worker-model.json`. Unconfigured delegates fail descriptively; `/worker-model` manages the saved config |
| `PI_WORKER_MODEL_THINKING` | Thinking level used with `PI_WORKER_MODEL`; defaults to `high` |
| `PI_WORKER_MODEL_CONFIG` | Alternative worker-model config-file path |
| `PI_WORKER_EXTENSIONS` | Comma-separated extension names for workers; wins over `worker-extensions.json` |
| `PI_WORKER_EXTENSIONS_CONFIG` | Alternative worker-extensions config-file path |
| `PI_MAX_WORKERS` | Concurrent worker cap (default 4) |
| `PI_WORKER_TIMEOUT_S` | Hard per-worker timeout (default 900) |
| `PI_WORKER_COMMAND` | Worker binary override (testing) |

Worker extensions resolve to `delegate` param → `PI_WORKER_EXTENSIONS` → `<agentDir>/worker-extensions.json` (normally `~/.pi/agent/worker-extensions.json`) → default set `[messenger, code-search, context7, web-search, synthetic, neuralwatt, gondolin]`. Set `PI_WORKER_EXTENSIONS_CONFIG` to use another config file. `messenger` and `gondolin` are mandatory and cannot be removed by configuration. Workflow extensions (`agents`, `missions`, `autoresearch`, `goal`, `plan`) are forbidden in workers and rejected outright. Delegating from a planning session adds the plan extension's headless gate and `--worker-readonly`; only the research-tool allowlist remains active.

## Model tiering

Workers should use a cheap model; keep design decisions, integration, and review in the main session. The worker model has no built-in default and must be selected with `/worker-model` or `PI_WORKER_MODEL`. That selection applies to every delegate call.

| Setting | Default | Purpose |
|---------|---------|---------|
| Worker model | None | Model for delegated workers |
| Worker thinking | `high` | Thinking level, clamped to the selected model's capabilities |
| `PI_WORKER_TIMEOUT_S` | `900` | Hard per-worker timeout |
| `PI_MAX_WORKERS` | `4` | Concurrent worker cap |

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerTool("delegate" / "workers")` | Delegation and worker management |
| `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })` | Trusted wake on worker exit |
| `pi.on("session_start" / "session_shutdown")` | Reconcile orphaned records / cancel running workers |
| `pi.events.emit("agents:state")` | Publishes worker-count state (`{ running: <n> }`) for future consumers such as the status bar |
| `ctx.ui.setWidget("agents", …)` | Framed panel above the input: running workers (`N running` in the frame corner), cleared when none |

**Worker sandbox**: every worker loads the Gondolin extension and runs with `--gondolin` (QEMU micro-VM; requires Node >= 23.6 and QEMU on `PATH`). Built-in file and shell tools are routed through the VM. A worker without a working sandbox fails loudly rather than falling back to the host.

State lives in `<cwd>/.pi/workers/` and `<cwd>/.pi/worktrees/` (gitignored runtime state).
