# Missions Extension

Durable missions: long-lived objectives with a task graph, checkpoints, decisions, and a budget, persisted as JSON under `<cwd>/.pi/missions/` so they survive restarts. The `mission` tool lets the agent maintain the record; `reconcile` re-runs done tasks' verification commands and flags regressions so the record can be checked against reality.

## Usage

Ask the agent in plain language, or drive the tool directly:

```text
Create a mission to migrate the auth module; break it into tasks with verification.
```

```text
mission (action=create, title="Migrate auth", objective="...", maxIterations=40)
mission (action=task_add, taskTitle="Map session storage", verification={command: "npm test"})
mission (action=task_update, taskId=task-x, status="done", summary="...")
mission (action=reconcile)
```

Commands:

| Command | Description |
|---------|-------------|
| `/missions` | List all missions for this project |
| `/mission:status` | Show the active mission's full status |
| `/mission:reconcile` | Re-run verification commands for done tasks; flags regressions |

Tool actions: `create`, `status`, `list`, `switch`, `task_add`, `task_update`, `task_verify`, `checkpoint`, `decision`, `set_budget`, `spend`, `set_status`, `reconcile`.

## How It Works

- **Storage**: one JSON file per mission under `.pi/missions/`. Mission writes are atomic and serialized across processes; an update based on stale data fails with instructions to reload mission status instead of overwriting another session's work. Which mission a session is working is session state, persisted in that session's transcript — missions affect only the session that created or switched to them, and two sessions can each hold their own active mission. Cross-session edits to the same mission are CAS-protected. Mission records stay out of git automatically: `session_start` appends `.pi/missions/` to the repository's local `.git/info/exclude`.
- **Task graph**: tasks declare `dependsOn` ids; a task cannot be marked done while dependencies are open, and `done` requires a delivery summary.
- **Verification**: tasks may carry a `verification` command. `reconcile` re-runs every done task's command; failures move the task to `regressed` so the record matches reality instead of optimism.
- **Budget**: `maxIterations`/`maxTokens` with a `spend` action that reports over-budget explicitly.
- **Cache safety**: missions deliberately does not inject per-turn context (that would break the provider prompt-cache prefix); the tool's guidelines tell the agent to consult mission status when working on mission tasks.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerTool("mission")` | Agent-facing mission operations |
| `pi.registerCommand` | `/missions`, `/mission:status`, `/mission:reconcile` |
| `pi.on("session_start")` | Restore active mission into status/widget |
| `pi.on("session_shutdown")` | Clear session UI |
| `pi.events.emit("missions:state")` | Publishes mission state (`{ active, status, title }`) for future consumers such as the status bar |
| `setStripWidget` (`lib/widget-strip.ts`) | Framed panel above the input at `WIDGET_PRIORITY_MISSIONS`: mission title/status, task lines, `tasks d/total` in the frame corner |
| `ctx.ui.setStatus("missions", …)` | Fallback footer line for pi's default footer (skipped by the bundled status bar, which shows the widget instead) |

## Configuration

None. Mission state lives in `<cwd>/.pi/missions/`.
