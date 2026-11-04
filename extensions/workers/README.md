# Workers Extension

Multi-worker workflows: spawn bounded, well-specified tasks as cheap-model worker Pi sessions. Every worker routes its built-in file and shell tools through the OS sandbox (`worker-sandbox`; bubblewrap on Linux, sandbox-exec on macOS) and has its own context and messenger identity. Workers that can make changes also get an isolated git worktree and branch by default. The parent session is woken when a worker exits; reports and patches are collected explicitly.

## Usage

```text
spawn_worker (task="Scout the auth subsystem: entry points, data flow, risks.", read_only=true)
spawn_worker (task="Replace all fmtAmount call sites with formatCurrency", isolate=true)
workers (action=list)
workers (action=status, id="w-...")
workers (action=collect, id="w-...")   # apply the worker's patch to the working tree
workers (action=collect, id="w-...", apply=false)   # keep the patch unapplied; collect again later to apply
workers (action=cancel, id="w-...")
workers (action=remove, id="w-...")   # delete a FINISHED worker's record and artifacts
```

You will be woken when a worker exits; read its report with `workers (action=status)` and apply its patch with `action=collect`. Use `wait: true` for short read-only tasks when you want the report inline.

## How It Works

- **Worker sessions**: `pi --mode json --no-session --no-extensions --model <worker> --thinking <level> -p <task>` with the required worker-sandbox, bash-allow, approval-mode, worker-blocker, and messenger extensions plus the configured extension set. The final assistant text becomes the worker's report. A final message settled by a provider error (`stopReason: "error"`) records the worker failed with the provider's error detail instead of a completed report. The child's stdout and stderr are files in the worker directory, not pipes to the parent — output survives the parent session's death, and any session can read or finalize the worker. Workers share the parent project's messenger state, so the parent can send mail to a running isolated worker. Workers cannot send mail; they report blockers and final results through the worker tools. Send peer guidance through the parent. Mail sent after a one-shot worker exits cannot reach it.
- **Worktree isolation**: workers that can modify files branch from `HEAD` into `.pi/worktrees/<id>` on branch `workers/<id>`. The tree must be clean so the worker starts from an unambiguous base. Finalization runs on every path — the spawning parent, an adopting session, and the janitor — and infers the outcome from the spool: a final assistant report stopped at the output limit (`stopReason: "length"`) records failed with an explicit output-limit cause, keeps the partial report readable via `workers (action=status)`, and still captures the patch. On completion, committed changes, uncommitted changes, and new files are captured in a patch under `.pi/workers/patches/`. Staging follows the project's Git ignore policy: ignored artifact directories (`.npm-cache`, `node_modules`, build output) never enter a patch, and extension runtime state under `.pi/` is excluded — so declare worker artifact directories in `.gitignore`. Patches are binary-safe. Worktree creation records the source worktree in private Git metadata. Capture validates the patch there with `git apply --check`, including linked source worktrees. Legacy workers without that record use the main checkout. If it cannot apply, capture refuses, stores nothing, and the record points at the missing patch so `collect` and retention keep the worktree for manual recovery. `collect` applies the patch to the current session's worktree and removes the worktree only after confirming that the patch still exists. Set `read_only: true` to inspect the current workspace without a worktree or patch. The sandbox denies workspace writes even when the project's policy allows them. `isolate: false` without `read_only: true` remains writable in the current workspace; use it only when that access is intentional.
- **Trusted wakes**: wake messages carry only ids and status words, never worker output — output is read on demand via the workers tool, so a worker's stdout is never injected as user-authored content.
- **Session-scoped records**: each session's transcript is the source of truth for its own workers. Every state transition appends a `worker-record` entry to the session, so records survive reloads and are restored by `pi -c`/`pi -r` together with the conversation. Resuming a session re-adopts its running workers: they are watched, keep their original hard-timeout deadline, finalize on exit (report, patch, wake), and can be cancelled from the tool. `workers action=list` shows this session's workers by default; other sessions' workers are never presented as your own. Removing one of this session's workers appends a removal marker, so reloads do not restore it. Workers owned by another live session cannot be removed here. On shutdown, running workers are cancelled (SIGTERM process group, then SIGKILL).
- **Artifact files + janitor**: project disk keeps per-worker artifact files under `.pi/workers/` — `records/<id>.json` (single-writer metadata including the parent pid and session id), `streams/<id>.jsonl` (the child's own event stream) plus `streams/<id>.stderr.log`, and `patches/<id>.diff`. On `session_start`, a janitor terminalizes leftovers whose worker process is dead (status inferred from the spool — a worker that finished while its session was away is recorded completed with its patch captured), adopts still-running leftovers as watchers so they finalize when they exit, and warns only about workers still running from ended sessions (cancellable from the tool). Terminal leftovers are silent: discoverable via `workers (action=list, scope=orphans)`, collectable/removable, drained by retention — never deleted silently. Worktree directories with no record file are discarding-able by id via `remove`. A one-time migration imports the legacy shared `registry.json` into per-worker record files and removes it.
- **Worktree lifecycle**: `remove` and the 7-day retention purge discard the worker's worktree directory and `workers/<id>` branch along with the record — the failed/cancelled case no longer strands a full checkout. The discard is skipped while the patch file is missing and the worktree would be the only remaining copy of the worker's changes.
- **Retention**: finished workers' artifacts are kept 7 days (`WORKER_RETENTION_MS`), then pruned on `session_start` (record file, stream spool, stderr log, patch); running records are never pruned. When patch capture fails, retention keeps the record and worktree until the changes are recovered. `workers (action=remove)` deletes a finished record and its artifacts on demand; it is also the way to reject a patch you do not want to apply. The status-bar worker-spend roll-up is session-scoped, bounded by this 7-day window.
- **Runaway guards**: default max 4 concurrent workers per session (`PI_MAX_WORKERS`), hard per-worker timeout (`PI_WORKER_TIMEOUT_S`, default 900s), unique running names (checked against this session and other live sessions' workers on a best-effort basis). An isolated spawn holds a slot during setup, so a limit refusal cannot commit setup files. Cancelling a waited spawn during setup stops the hook before the worker starts. Finalization scans the whole spool in one bounded-memory streaming pass (an oversized trailing event cannot hide the final assistant message) and reads a bounded stderr tail.

## Configuration

| Variable | Description |
|----------|-------------|
| `PI_WORKER_MODEL` | `provider/model-id` for every worker; wins over `worker-model.json`. Unconfigured spawn_worker calls fail descriptively; `/worker-model` manages the saved config |
| `PI_WORKER_MODEL_THINKING` | Thinking level used with `PI_WORKER_MODEL`; defaults to `high` |
| `PI_WORKER_MODEL_CONFIG` | Alternative worker-model config-file path |
| `PI_WORKER_EXTENSIONS` | Comma-separated extension names for workers; wins over `worker-extensions.json` |
| `PI_WORKER_EXTENSIONS_CONFIG` | Alternative worker-extensions config-file path |
| `PI_MAX_WORKERS` | Concurrent worker cap (default 4) |
| `PI_WORKER_TIMEOUT_S` | Hard per-worker timeout (default 900) |
| `PI_WORKER_COMMAND` | Worker binary override (testing) |
| `PI_MESSENGER_PROJECT_ROOT` | Internal child-process setting. The parent sets it to the parent project's absolute path for worker sessions, overriding any inherited value. |
| `PI_WORKER_APPROVAL_FD` | Internal child-process setting. The runner sets it to descriptor `3` for the dedicated parent approval pipe. |

Worker extensions resolve to the spawn_worker `extensions` param → `PI_WORKER_EXTENSIONS` → `<agentDir>/worker-extensions.json` (normally `~/.pi/agent/worker-extensions.json`) → default set `[messenger, code-search, context7, web-search, synthetic, neuralwatt, approval-mode, worker-sandbox]`. Set `PI_WORKER_EXTENSIONS_CONFIG` to use another config file. `messenger`, `worker-blocker`, `bash-allow`, `approval-mode`, and `worker-sandbox` are mandatory. Workflow extensions (`workers`, `missions`, `autoresearch`, `goal`) are forbidden. `read_only: true` loads the research-tool gate and denies workspace writes in the sandbox. Workers follow the parent's live approval mode. `/approval-mode off` skips Jev review for running and future workers, but hard denies and sandbox limits remain active. Flagged commands pause for approval in the parent's dialog. Approval releases one call inside the same sandbox. A lost parent connection blocks commands that need review. See [Approval Mode](../approval-mode/README.md#worker-approvals).

### Shell allow-list inheritance

Every worker loads `bash-allow` before `approval-mode`, regardless of the requested extension list.
The launcher requests the parent gate's effective list through `bash-allow:request` and passes it as `--bash-allow=<list>`.
This preserves parent flag priority over `PI_BASH_ALLOW` without changing the parent's process environment.
If the parent gate is absent, the launcher uses `PI_BASH_ALLOW` when it exists.

Empty and malformed lists remain blocking in the worker.
A missing mandatory extension prevents worker startup; it does not remove the restriction.
Without a list, `bash-allow` does nothing and existing approval and sandbox controls remain active.
Workers cannot override the list through tool arguments or custom extension selections.
Each worker keeps the list from its startup; parent configuration changes apply to future workers.
An allow-listed call can still require parent approval. See [bash-allow](../bash-allow/README.md).

## Model tiering

Workers should use a cheap model; keep design decisions, integration, and review in the main session. The worker model has no built-in default and must be selected with `/worker-model` or `PI_WORKER_MODEL`. That selection applies to every spawn_worker call.

For opt-in task selection and availability recovery, use [`virtual-models/worker-auto-v1`](../virtual-models/README.md#worker-selection-and-recovery).
Jev selects model families. Code applies the configured provider order within each family.
Rules apply only when classification cannot return a valid choice.
DeepSeek and GLM try alternate providers before another family choice. Codex quota or repeated temporary failures stop the worker without a replacement.
Recovery retains the same worker process and completed tool results. Direct compaction failures remain outside that recovery.
Load `virtual-models` in the worker extension list as well as the parent. Follow the temporary setup instructions to preserve saved defaults.
Mandatory sandbox controls, parent approvals, and isolation settings remain unchanged.

Worker widgets show the configured router and latest physical model/provider. Effective thinking appears when the event reports it.
Worker status includes the full physical identifier. Finalization restores physical metadata from the stream after parent loss.
The main-session model label remains unchanged.

| Setting | Default | Purpose |
|---------|---------|---------|
| Worker model | None | Model for spawned workers |
| Worker thinking | `high` | Thinking level, clamped to the selected model's capabilities |
| `PI_WORKER_TIMEOUT_S` | `900` | Hard per-worker timeout |
| `PI_MAX_WORKERS` | `4` | Concurrent worker cap |

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerTool("spawn_worker" / "workers")` | Worker spawning and management |
| `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })` | Trusted wake on worker exit |
| `pi.on("session_start" / "session_shutdown")` | Reconcile orphaned records / cancel running workers |
| `pi.events.emit("bash-allow:request")` | Requests the effective parent command list through a synchronous reply callback |
| `pi.events.emit("approval-mode:worker-request")` | Requests live mode or a user decision through the parent Approval Mode extension |
| `pi.events.emit("workers:state")` | Publishes worker state (`{ running, workerCostUsd, workerTokens }`); the status bar subscribes and shows the delegated-worker spend roll-up next to the session cost |
| `setStripWidget` (`lib/widget-strip.ts`) | Framed panel above the input at `WIDGET_PRIORITY_WORKERS`: running workers (`N running` in the frame corner), cleared when none |

**Worker sandbox**: every isolated worker is provisioned by the project-owned setup files — the executable hook `.pi/provision-worktree`, the carry file `.worktreeinclude`, and the sandbox policy `.pi/sandbox.json`. The hook runs once per worktree inside the sandbox; its log lands in the provision cache with the failure pointer. The sandbox (`@anthropic-ai/sandbox-runtime`; preflight requires `bwrap` and `socat` plus `rg` on Linux) enforces the policy's read/write/network rules for every built-in tool and `!`. A worker without a working sandbox fails loudly rather than falling back to the host: initialization failure kills all tool calls.

Use `mktemp -d "$PWD/.pi/provision-tmp-XXXXXXXX"` for hook scratch directories. Omit `-d` for scratch files. The `provision-tmp-` prefix plus eight random characters is required: Git exclusion and patch capture discard these paths after a hook dies. The tracked hook itself lives at `.pi/provision-worktree` and must not match the scratch pattern. Other temporary names can enter a worker patch.

State lives in `<cwd>/.pi/workers/` and `<cwd>/.pi/worktrees/` (gitignored runtime state).
