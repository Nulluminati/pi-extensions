# Pi Mission Board

A Herdr plugin: one read-only terminal pane that shows a project's missions,
straight from the missions extension's own storage at
`<project>/.pi/missions/`. The board never writes mission state.

## Install

```sh
herdr plugin link <this-repo>/plugins/mission-board
```

Requires Herdr 0.9.0 or newer, Linux or macOS, and Node 22.19+ on `PATH`
(the scripts run as plain TypeScript, no build step).

## Use

1. Select a workspace in Herdr.
2. Run the **Mission board** action.
3. The board opens as its own **Missions** tab in that workspace. Running
   the action again focuses the existing board instead of opening another.

You can also open it directly:

```sh
herdr plugin pane open --plugin pi.mission-board --entrypoint board
```

## What the board shows

- The most recently updated mission, expanded: objective, status, budget
  and spend, every task with status, dependencies, and owner, plus
  checkpoints and recent decisions.
- All other missions as one-line summaries with task counts.
- A notice when mission files are corrupt and skipped.

Mission state lives in the project. Which mission a Pi session is working
on is session state, so the board expands the newest-updated mission rather
than guessing a session's active pointer.

## Design

The board reuses the Workers tab's visual language: rounded terminal-palette
frames, status icons and colors, key hints, and compact fallbacks for narrow
or short panes. History is not paged — the board always shows the current
state.

## Controls

| Key | Action |
| --- | --- |
| `q` or Ctrl+C | Close the board |

The board repaints once per second. It never launches workers, mutates
missions, or injects output into a conversation.
