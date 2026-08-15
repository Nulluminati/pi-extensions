# Todo List Extension

A persistent todo list the agent manages with the `todo` tool. Items render as a ☐/☑ widget above the editor, survive reloads, and work in any session — no plan mode required.

## What It Does

The agent calls the `todo` tool to build a checklist, then ticks items off as it works. The list shows live above the editor, so you always see what's done and what's left. The state is shared via `lib/todos.ts`, which is also what the plan extension uses: approving a plan replaces the list with the plan's steps, and checking the last item off completes the plan.

## Usage

The agent drives the list through the tool; you inspect and manage it with commands:

```
/todos            Show the current list
/todos:clear      Empty the list
```

### The `todo` tool

| Action | Params | Effect |
|---|---|---|
| `add` | `items: string[]` | Append items to the list |
| `check` | `ids: number[]` | Mark items complete (1-based, matching the displayed list) |
| `uncheck` | `ids: number[]` | Reopen items |
| `list` | — | Return the current list |
| `clear` | — | Empty the list |

Every result includes the current list so the agent can see its own progress. The widget and the list stay in sync through the `todos:changed` event on the shared bus.

## How It Works

| Hook / API | Purpose |
|---|---|
| `pi.registerTool("todo")` | The LLM-facing interface: add/check/uncheck/list/clear |
| `lib/todos.ts` | Shared per-instance store: mutations, `appendEntry("todos-state")` persistence, `todos:changed` event publishing |
| `pi.events.on("todos:changed")` | Re-render the widget after any mutation, including ones made by other extensions via the lib |
| `pi.registerCommand("todos")` / `pi.registerCommand("todos:clear")` | User-facing list inspection and cleanup |
| `pi.on("session_start")` / `pi.on("session_tree")` | Reconstruct the store from the last persisted snapshot |

## Configuration

None.

## Notes

- **State is per session.** The list is stored in the session file and reconstructed on reload, resume, and tree navigation. `/todos:clear` (or the `clear` action) dismisses it.
- **Plan integration.** The plan extension replaces the list with the approved plan's steps when execution starts; it leaves the finished list in place when the plan completes. Nothing here depends on plan — the list works standalone.
- **One widget owner.** Only this extension renders the `todos` widget; other extensions mutate the list through `lib/todos.ts` and the widget follows via the event bus.
