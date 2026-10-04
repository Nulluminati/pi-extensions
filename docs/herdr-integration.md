# Herdr integration plan

Section 2 is complete. Sections 3 and 4 describe proposed work.

Use Herdr for terminal layout and visibility. Keep Pi and this repository responsible for agent behavior and worker safety.

## 2. Status adapter: complete

The optional [Herdr extension](../extensions/herdr/README.md) uses this structure:

```text
extensions/herdr/herdr.ts
extensions/herdr/src/
test/extensions/herdr.test.ts
```

The adapter subscribes to events that existing extensions publish. It sends display metadata to Herdr.

| Existing event | Herdr display |
| --- | --- |
| `missions:state` | Mission title and status |
| `workers:state` | Running worker count, worker cost, and worker tokens |
| `todos:changed` | Completed and total tasks |
| `goal:state-change` | Goal iteration and limit |
| `messenger:state` | Session name and unread messages |

Herdr supports [pane and workspace metadata](https://herdr.dev/docs/socket-api/#agent-state-reporting). These values can appear beside agents without changing their activity state.

Keep the [official Pi integration](https://herdr.dev/docs/integrations/#pi) responsible for activity state and session restore. The adapter publishes display metadata only.

The adapter does nothing outside an interactive Herdr pane. It does not report headless workers as occupants of their parent's pane.

Metadata expiry and sequence numbers prevent stale or out-of-order display updates. The adapter closes connections and removes listeners on shutdown.

The `pi_cost` token combines active-branch session cost with worker cost. The `pi_worker_cost` token remains worker-only.

The adapter adds unrounded values before formatting the combined total. It uses the same session accounting as the status bar.

### Blocked dialogs: complete

The repository's `ask-user` and `approval-mode` extensions emit balanced `herdr:blocked` events.

The inspected official Pi integration, version 9, listens for this event. It counts active blockers and reports the pane as blocked.

The dialog paths follow these rules:

1. Emit `herdr:blocked` with `{ active: true, label }` when a dialog starts to wait for input.
2. Emit `{ active: false }` when that dialog finishes, cancels, or fails.
3. Use cleanup that guarantees one clearing event for each active event.

Keep the clearing event in a `finally` block. Do not emit an active event for a dialog that never opens.

Tests cover normal completion, cancellation, errors, and overlapping dialogs. Adapter tests cover execution outside Herdr and metadata cleanup.

Repository checks and a live Pi terminal test passed. The live test verified metadata, blocked-state reporting, and shutdown cleanup.

## 3. Show workers without replacing the worker runner

Workers are not interactive Pi sessions. [`startWorker()`](../extensions/workers/src/runner.ts) launches Pi in JSON mode and writes output to durable files.

The [workers extension](../extensions/workers/README.md) maintains these controls:

- Operating-system sandbox enforcement.
- Worktree provisioning and patch capture.
- Global worker-model selection.
- A dedicated parent approval connection on file descriptor 3.
- Worker timeouts and cancellation.
- Wake messages that contain identifiers and status, not worker output.

Keep these controls in the existing runner.

### Start with read-only monitor panes

Add Herdr panes that display existing worker records and event files:

```text
.pi/workers/records/<id>.json
.pi/workers/streams/<id>.jsonl
.pi/workers/streams/<id>.stderr.log
```

The monitor would show worker status, recent activity, and bounded output. It would not launch workers or change their records.

The existing runner would continue to launch, supervise, and finalize every worker. The parent would still inspect reports and collect patches through the `workers` tool.

Implement the monitor in this order:

1. Add a read-only viewer for worker records and event files.
2. Open the viewer in a Herdr pane without changing keyboard focus.
3. Track the returned pane identifier so cleanup affects only owned panes.
4. Verify that closing a monitor leaves the worker running.

Monitor output must remain display-only. Do not inject it automatically into the parent conversation.

Tests must cover missing files, partial event records, completed workers, and pane cleanup. Verify that monitor operations do not change worker artifacts.

### Defer interactive worker launches

Interactive Pi workers inside Herdr require a separate launch adapter. A plain `herdr agent start --kind pi` does not preserve our approval connection or worker lifecycle.

Before adding interactive launches, define how the adapter preserves:

- Mandatory worker extensions and their restrictions.
- Sandbox policy and worktree provisioning.
- Worker-model enforcement.
- Parent approval requests and live approval-mode changes.
- Durable output, timeouts, cancellation, and patch collection.

Herdr [does not sandbox plugin code](https://herdr.dev/docs/plugins/#trust-and-security). A separate worktree does not provide permission isolation.

Keep the current worker runner as the default. Do not replace it as part of the status adapter or monitor work.

## 4. Add Herdr workflow actions

A small Herdr plugin could provide actions around the existing Pi workflow:

| Proposed action or pane | Behavior |
| --- | --- |
| Open Pi | Start Pi in the selected project with its normal extension configuration |
| Mission board | Display the project's existing mission state in a separate terminal pane |
| Worker monitors | Open read-only monitor tabs for existing workers |
| Project layout | Open a layout with Pi, tests, and server logs |

Herdr plugins use a `herdr-plugin.toml` manifest and executable commands. They do not require a separate software development kit.

See [Herdr plugins](https://herdr.dev/docs/plugins/) for actions, terminal panes, event hooks, and invocation context.

### Keep state ownership unchanged

Mission and worker files remain authoritative. Do not create a second task database in Herdr.

The mission board would read existing state. Any future mutation action must use an explicit, validated interface to the extension that owns that state.

Use the selected workspace's project path rather than the plugin's working directory. Herdr runs plugin commands from the plugin directory.

Call Herdr through `HERDR_BIN_PATH` when available. Pass commands as argument arrays rather than shell strings.

Track pane ownership by returned identifiers, not labels. Keep plugin configuration and runtime state outside the installed source directory.

Herdr actions must not provide an unreviewed route around Approval Mode. Define approval behavior before adding actions that execute agent-requested commands.

### Add actions incrementally

1. Add an action that opens Pi in the selected project.
2. Add a read-only mission board.
3. Connect the worker viewer to plugin pane entrypoints.
4. Add an explicit project-layout action.

Check the installed Herdr capabilities before selecting the manifest's minimum version. Do not assume the latest documentation matches every installed server.

Tests must cover project-path selection, command arguments, pane ownership, and unavailable Herdr APIs.

## First implementation scope

Status metadata and blocked-dialog events are complete. Next, add read-only worker monitors. Keep worker execution unchanged.

Next: define the worker viewer's command and pane lifecycle.
