# Background Jobs

Long-running work without blocking the turn. The agent starts shell commands
detached, keeps working, and is woken when a job finishes or a condition holds.

## What It Does

Three model-callable tools plus one user command:

- **`background`** — run a shell command detached in its own process group and
  return immediately with a job id. The agent is woken when the command exits;
  if `wake_on_pattern` is set, it is also woken the first time output matches.
- **`monitor`** — poll a command on an interval until a condition holds
  (`exit_zero`, `exit_nonzero`, `stdout_matches`, `stdout_not_matches`) or a
  timeout fires, then wake the agent.
- **`jobs`** — list jobs, inspect status, tail captured output, cancel a
  running job.
- **`/jobs`** — open the interactive jobs panel (user-only; the agent cannot
  open modals).

Wake messages are extension-authored and trusted. They carry only the job id,
label, and a status word — never command output. Output is read on demand with
the `jobs` tool, so a malicious command's stdout is never injected as
user-authored content.

## Usage

### Run a command in the background

The model calls `background` with:

| Parameter | Required | Meaning |
|-----------|----------|---------|
| `command` | yes | Shell command run under `/bin/sh` in its own process group |
| `label` | no | Short label; defaults to the command's first token |
| `cwd` | no | Working directory; defaults to the project root |
| `wake_on_pattern` | no | Regexp; wake early on the first output match (once) |
| `env` | no | Extra environment variables, merged over the inherited environment |

### Poll for a condition

The model calls `monitor` with:

| Parameter | Required | Meaning |
|-----------|----------|---------|
| `command` | yes | Shell command polled under `/bin/sh -c` on each tick |
| `satisfy_on` | yes | `exit_zero`, `exit_nonzero`, `stdout_matches`, or `stdout_not_matches` |
| `pattern` | for `stdout_*` | Regexp the polled output must (not) match |
| `interval_seconds` | no | Poll interval in seconds; default 10 (values below 1 fall back to the default) |
| `timeout_seconds` | no | Give up after this many seconds; default 600 |
| `label` | no | Short label for the monitor |

The first poll runs immediately. Polls are scheduled only after the previous
poll finishes, so they never overlap. Three consecutive broken polls (a
not-found marker such as "command not found" in stderr) abort the monitor
early with a diagnostic instead of running to the deadline.

### Manage jobs

The model calls `jobs` with `action`:

- `list` — one line per job with status, kind, label, and elapsed time.
- `status` — full command and start time for one job.
- `tail` — last N lines of captured output (default 40, hard cap 6,000 chars).
- `cancel` — stop a running job or monitor.

### Inspect interactively

```
/jobs
```

Opens a focusable overlay: `↑↓`/`j`/`k` navigate, `enter` pages the selected
job's output, `esc` steps back then closes, `q` closes. The body adapts to the
terminal height with a sliding window that keeps the selection visible.

## How It Works

### Wake delivery

Wakes are sent with `pi.sendMessage`, custom type `background-jobs:wake`,
`triggerTurn: true`, and `deliverAs: "steer"` — the message injects right
after the current tool-call batch, or starts a fresh turn when the agent is
idle. Shutdown suppresses wakes.

### Capture and spool

Output (stdout and stderr) feeds a rolling in-memory buffer (200,000 chars per
job) and is appended, best-effort, to a spool file. The tail sent back to the
model is capped at 6,000 chars. Cancellation escalates SIGTERM to the whole
process group, waits a 4-second grace, sends SIGKILL, then waits 2 more
seconds; a group that survives is recorded honestly as `kill_failed`.

### State and spool location

The job registry is in-memory and session-scoped; a snapshot is appended to
the session transcript via `pi.appendEntry("background-jobs")`. Spool logs
live under the agent state directory:

```
<agentDir>/background-jobs/job-<id>-p<pid>-<label>.log
```

`<agentDir>` follows `PI_CODING_AGENT_DIR` (default `~/.pi/agent`).

### Retention

On `session_start`, the spool directory is pruned: logs older than 7 days are
deleted, then the oldest logs beyond a 200-file cap. The current session's
live jobs' logs are never deleted, and a pid-stamped log whose owning process
is still alive (another session's active job) is never deleted either.
Terminal jobs are pruned from memory past 50 per session.

### Widget

Active jobs render in a framed "Jobs" widget above the editor (todos-style):
up to three `#id label` lines plus a "↓ N more" indicator and an "N running"
count in the top-right cell. It is published through the shared widget strip,
removed when no jobs are active, and re-registered on `session_start`.

## Key Design Decisions

- **Output never enters the wake** — wakes carry ids and status words only;
  the model reads output on demand. This keeps untrusted command output out of
  the message stream.
- **Detached process groups** — jobs survive in their own group, so
  cancellation can SIGTERM/SIGKILL every child, not just the shell.
- **Session-scoped registry** — no cross-session job state to reconcile; the
  transcript snapshot and pid-stamped spool names are enough to audit past
  jobs later.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerTool()` | Registers `background`, `monitor`, and `jobs` |
| `pi.exec()` | Runs each monitor poll under `/bin/sh -c` |
| `pi.registerCommand("jobs")` | The `/jobs` panel command |
| `pi.on("session_start")` | Resets the registry and prunes the spool |
| `pi.on("session_shutdown")` | Cancels active jobs, suppresses wakes |
| `pi.sendMessage()` | Trusted wake messages (`triggerTurn`, `deliverAs: "steer"`) |
| `pi.appendEntry("background-jobs")` | Registry snapshot on the session branch |
| `ctx.ui.custom()` | The focusable `/jobs` overlay panel |
| `ctx.ui.setStatus("background-jobs", …)` | Fallback footer line for pi's default footer (skipped by the bundled status bar, which shows the widget instead) |
| `lib/widget-strip.ts` / `lib/framed-widget.ts` | The Jobs editor widget |
| `lib/paths.ts` (`agentStateDir`) | The spool directory |
| `lib/presence-shards.ts` (`isProcessAlive`) | Spool liveness checks during pruning |

## Configuration

None. There are no flags, environment variables, or config files; the spool
location follows `PI_CODING_AGENT_DIR`.
