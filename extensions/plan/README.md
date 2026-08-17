# Plan Mode Extension

Strict read-only planning with an approval gate — Claude-Code-style. `/plan` puts Pi into plan mode where it researches your request but cannot change anything, then proposes a structured plan you approve, edit, or reject before any work happens.

## What It Does

Plan mode has three phases:

1. **Plan** (`/plan`, `Ctrl+Alt+P`, or `--plan`) — the `edit` and `write` tools are removed from the active tool set *and* hard-blocked at the `tool_call` gate. Bash is restricted to a read-only allowlist (`cat`, `grep`, `git status/log/diff`, `npm view`, `ps`, `jq`, ...); anything mutating (`rm`, `mv`, `>`, `git checkout`, `npm install`, `sed -i`, `curl | sh`, ...) is blocked with an explanation. A plan-context message tells the model to research and call `plan_submit` when it has a complete plan.
2. **Approval** — `plan_submit` (a tool that is only active in plan mode) shows the proposed plan in a framed overlay:

   - `Enter` — **approve & execute**: full tool access is restored, execution context with the numbered steps is injected, and the plan runs.
   - `Esc` — **keep planning**: nothing changes; type your feedback in the chat and ask for a revised plan.

   While plan mode is active, the input editor frame (when the status-bar extension is loaded) shows **Plan Mode** on the right side of its title bar and tints with the theme's warning color, so the read-only state is visible at a glance.

3. **Execution** — the approved plan runs with full tool access. Its steps become the shared todo list (`lib/todos.ts`): the agent checks items off with the `todo` tool as it finishes them, and a ☐/☑ widget above the editor (owned by the todos extension) tracks progress. When every item is checked, the mode ends automatically with a "Plan complete" message.

State persists across `/reload`, `/resume`, and tree navigation: mode, plan, and the pre-plan tool set are stored as a session entry and reconstructed on `session_start`. Step progress lives in the shared todo list, which the todos extension also reconstructs.

## Usage

```
/plan            Toggle plan mode on/off (also Ctrl+Alt+P)
/plan:status     Show current mode and plan progress
pi --plan        Start pi already in plan mode
```

Stale plan-mode instructions are stripped from the model context every turn and re-injected fresh, so research turns don't accumulate context drift.

## How It Works

| Hook / API | Purpose |
|---|---|
| `pi.registerFlag("plan")` | Start in plan mode via `--plan` |
| `pi.registerCommand("plan")`, `pi.registerShortcut("ctrl+alt+p")` | Toggle the mode |
| `pi.setActiveTools()` | Remove `edit`/`write`, add `plan_submit` while planning; restore the captured tool set on exit |
| `pi.on("tool_call")` | Hard gate: block `edit`/`write` and non-allowlisted bash with `{ block, reason }`; the reason is reported to the model and the turn continues so the agent can keep working read-only |
| `pi.on("before_agent_start")` | Inject per-turn plan or execution context messages |
| `pi.on("context")` | Drop stale injected context copies between turns |
| `pi.registerTool("plan_submit")` | Structured plan (title + steps) with `terminate: true`; drives the approval overlay and the approve → execute transition |
| `lib/todos.ts` (`setTodoItems` / `getTodoItems`) | Approved steps become the shared todo list; completion is read back from it |
| `pi.on("agent_end")` | End the mode when every plan step is checked in the todo list |
| `pi.appendEntry("plan-state")` | Persist mode, plan, and tool set; reconstruct on `session_start` / `session_tree` |
| `pi.events.emit("plan:mode-change")` | Publish mode changes on the shared bus; status-bar shows **Plan Mode** on the editor frame's right side and tints it warning-colored while planning |

## Configuration

No configuration. `--plan` is the only flag.

## Limitations

- **Other extensions' mutating tools are not gated.** Only the built-in `edit`/`write` tools and bash are enforced. A custom tool that mutates files is the agent's to misuse — the plan-context message tells it not to.
- **The bash allowlist is conservative.** Anything not on it is blocked, which occasionally blocks unusual-but-read-only commands (e.g. `git stash show`). Blocked commands report the reason; exit plan mode to run them.
- **Approval needs an interactive session.** In headless modes `plan_submit` saves the plan and asks the agent to retry when a user can review it.
- **Completion relies on the agent checking items off with the `todo` tool.** If the model never calls it, execution stays active — toggle `/plan` to abort back into plan mode. Only the first `steps.length` items count toward completion, so extra agent-added items don't block it.
- **The input-bar indicator and tint need the status-bar extension; the todo widget needs the todos extension.** Without them, plan mode is signaled by the blocked-tool messages and progress is visible only through the `todo` tool output.
