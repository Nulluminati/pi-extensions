# Agents Extension

Multi-agent workflows: delegate bounded, well-specified tasks to cheap-model worker Pi sessions. Each worker is a detached `pi --mode json --no-session` process with its own context and messenger identity, by default inside an isolated git worktree and branch so parallel workers never collide on files. The parent session is woken when a worker exits; reports and patches are collected explicitly.

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

- **Worker sessions**: `pi --mode json --no-session --no-extensions -p <task>` with the messenger extension loaded so workers can coordinate home. The final assistant text becomes the worker's report; usage is tracked per worker.
- **Worktree isolation**: isolated workers branch from `HEAD` into `.pi/worktrees/<id>` on branch `agents/<id>`. The tree must be clean — otherwise the captured patch would silently miss uncommitted work. On completion everything the worker changed (including new files) is captured as a patch under `.pi/workers/patches/`; `collect` applies it to the main tree and removes the worktree. Worktrees provide *coordination* isolation, not security: workers run with user privileges.
- **Trusted wakes**: wake messages carry only ids and status words, never worker output — output is read on demand via the workers tool, so a worker's stdout is never injected as user-authored content.
- **Durable registry**: `.pi/workers/registry.json` survives restarts. Any read reconciles records stuck in `running` whose pid is dead (marked failed), so crashed parents leave no permanent ghosts and their concurrency slots are freed; on shutdown, running workers are cancelled (SIGTERM process group, then SIGKILL).
- **Runaway guards**: default max 4 concurrent workers (`PI_MAX_WORKERS`), hard per-worker timeout (`PI_WORKER_TIMEOUT_S`, default 900s), unique running names.

## Model Tiering

The default worker model is cheap on purpose — keep design decisions, integration, and review in the main session:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PI_WORKER_MODEL` | `opencode-go/glm-5.3-flash` | Model for delegated workers |
| `PI_WORKER_TIMEOUT_S` | `900` | Hard per-worker timeout |
| `PI_MAX_WORKERS` | `4` | Concurrent worker cap |

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerTool("delegate" / "workers")` | Delegation and worker management |
| `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })` | Trusted wake on worker exit |
| `pi.on("session_start" / "session_shutdown")` | Reconcile orphaned records / cancel running workers |
| `pi.events.emit("agents:state")` | Publish state for the status bar |

State lives in `<cwd>/.pi/workers/` and `<cwd>/.pi/worktrees/` (gitignored runtime state).
