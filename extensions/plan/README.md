# Plan Mode Extension

Strict read-only planning with an approval gate — Claude-Code-style. `/plan` puts Pi into plan mode where it researches your request but cannot change anything, then proposes a structured plan you approve, edit, or reject before any work happens.

## What It Does

Plan mode has three phases:

1. **Plan** (`/plan`, `Ctrl+Alt+P`, or `--plan`) — the `edit` and `write` tools are removed from the active tool set *and* hard-blocked at the `tool_call` gate. Bash is restricted to a read-only allowlist (`cat`, `grep`, `git status/log/diff`, `npm view`, `ps`, `jq`, ...); anything mutating or composing (`rm`, `mv`, `>`, `git checkout`, `npm install`, `sed -i`, `curl | sh`, `$(...)`, `<(...)`, ...) is blocked with an explanation. The model can delegate bounded research to read-only workers running in Gondolin, then calls `plan_submit` when it has a complete plan.
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
| `pi.setActiveTools()` | Keep research and worker-orchestration tools, add `plan_submit`, and restore the captured tool set on exit |
| `pi.on("tool_call")` | Block `edit`/`write`, unsafe bash, worker patch collection, and any tool outside the active allowlist |
| `pi.on("before_agent_start")` | Inject per-turn plan or execution context messages |
| `pi.on("context")` | Drop stale injected context copies between turns |
| `pi.registerTool("plan_submit")` | Structured plan (title + steps) with `terminate: true`; drives the approval overlay and the approve → execute transition |
| `lib/todos.ts` (`setTodoItems` / `getTodoItems`) | Approved steps become the shared todo list; completion is read back from it |
| `pi.on("agent_end")` | End the mode when every plan step is checked in the todo list |
| `pi.appendEntry("plan-state")` | Persist mode, plan, and tool set; reconstruct on `session_start` / `session_tree` |
| `pi.events.emit("plan:mode-change")` | Publish mode changes on the shared bus; status-bar shows **Plan Mode** on the editor frame's right side and tints it warning-colored while planning |

## Configuration

No configuration. `--plan` is the only flag.

## Plan-mode safety guarantees

Plan mode is **default-deny**: while planning, the active tool set is the intersection of the session's tools with a research allowlist (`read`, `grep`, `find`, `ls`, `bash`, `todo`, `ask_user`, `messenger`, `code_search`, `context7_resolve_library_id`, `context7_get_library_docs`, `context7_get_cached_doc_raw`, `web_search`, `web_fetch`) plus `delegate`, `workers`, and `plan_submit`. Tools not on the allowlist are unavailable. Read-only workers use the research subset without `delegate`, `workers`, or `plan_submit`, which prevents nested delegation and unknown extension tools.

| Channel | Enforcement |
|---|---|
| Built-in `edit` / `write` | Excluded by the allowlist and blocked at `tool_call` |
| `bash` | Tool stays active, but every pipeline stage must be an allowlisted read-only command; command/process substitution, compound commands, redirection, destructive patterns, and interpreter-powered writes are blocked |
| `delegate` (agents) | Parent plan state forces `--worker-readonly`, mandatory Gondolin, the default-deny research tool set, and no worktree |
| `workers` | `list`, `status`, and `cancel` remain available; `collect` is blocked because applying a patch changes the workspace |
| `messenger` | Allowlisted coordination state (mail and reservations), not project files |
| Unknown / future extension tools | Default-deny in both the parent and planning workers |

## Limitations

- Read-only extension tools must be added to `PLAN_ALLOWED_TOOLS` before they can run in plan mode. This is a deliberate review point for each tool.
- Gondolin isolates worker tool operations, but loaded extension code still runs in the worker process. Only trusted worker extensions should be configured.
- The bash allowlist sometimes blocks unusual read-only commands such as `git stash show`. Exit plan mode to run one.
- Approval needs an interactive session. In headless modes, `plan_submit` saves the plan and asks the agent to retry when a user can review it.
- Completion depends on the agent checking steps off with the `todo` tool. If it does not, execution stays active; toggle `/plan` to abort back into plan mode. Extra agent-added items do not block completion.
- The input-bar indicator and tint need the status-bar extension. The todo widget needs the todos extension.
