# Todo List Extension

A persistent todo list the agent manages with the `todo` tool. Items render as a ☐/☑ widget above the editor, survive reloads, and work in any session.

## What It Does

The agent calls the `todo` tool to build a checklist, then ticks items off as it works. The list shows live above the editor, so you always see what's done and what's left. The state is shared via `lib/todos.ts`.

## Usage

The agent drives the list through the tool; you inspect and manage it with commands:

```
/todos                 Show the list in a framed panel (c clears completed items)
/todos:clear           Empty the list
/todos:clear-completed Remove completed items, keeping open ones
```

The panel uses the same frame and overlay treatment as the context view
(70% width, centered) and lists every item with its 1-based number.

### The widget

While items exist, a framed box sits above the editor. It shows what's left
to do: completed items are hidden (progress lives in the frame title, e.g.
`2/5 done`) and at most three open items are displayed, with a `↓ N more`
indicator for the rest. When everything is complete the finished items stay
visible. `/todos:clear-completed` (or `c` inside the panel) tidies it up.

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
| `pi.registerCommand("todos")` / `pi.registerCommand("todos:clear")` / `pi.registerCommand("todos:clear-completed")` | User-facing panel, full clear, and completed-only clear |
| `pi.on("session_start")` / `pi.on("session_tree")` | Reconstruct the store from the last persisted snapshot |

## Configuration

None.

## Notes

- **State is per session.** The list is stored in the session file and reconstructed on reload, resume, and tree navigation. `/todos:clear` (or the `clear` action) dismisses it; `/todos:clear-completed` keeps open items.
- **Widget numbers vs tool numbers.** The widget hides completed items, so item numbering there would drift from the store. The tool's own results always carry the authoritative 1-based list; the panel shows those same numbers.
- **Yields to the recap.** Both widgets publish through the shared widget strip (`lib/widget-strip.ts`); the recap's priority (0) always places it above the todo box (30), with no re-insertion tricks.
- **One widget owner.** Only this extension renders the `todos` widget; other extensions mutate the list through `lib/todos.ts` and the widget follows via the event bus.
