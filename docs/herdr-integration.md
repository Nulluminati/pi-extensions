# Herdr integration plan

The status adapter, session names, and read-only worker monitors are complete. Interactive worker launches and section 4 remain proposed work.

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
| `messenger:state` | Messenger name and unread messages |
| `session_start`, `session_info_changed` | Saved Pi session name |

Herdr supports [pane and workspace metadata](https://herdr.dev/docs/socket-api/#agent-state-reporting). These values can appear beside agents without changing their activity state.

Keep the [official Pi integration](https://herdr.dev/docs/integrations/#pi) responsible for activity state and session restore. The adapter publishes display metadata and mirrors Pi session names onto their owning panes.

The adapter does nothing outside an interactive Herdr pane. It does not report headless workers as occupants of their parent's pane.

Metadata expiry and sequence numbers prevent stale or out-of-order display updates. The adapter closes connections and removes listeners on shutdown.

The `pi_cost` token combines active-branch session cost with worker cost. The `pi_worker_cost` token remains worker-only.

The adapter adds unrounded values before formatting the combined total. It uses the same session accounting as the status bar.

### Session names: complete

The [session-name extension](../extensions/session-name/README.md) names all unnamed interactive Pi sessions, including sessions outside Herdr.

Each session starts with `Pi · project · short-id`. The global small model supplies a topic name after the first user message.

Naming runs beside the main turn. Existing and manual names remain unchanged. Session replacement and manual rename cancel pending work.

The Herdr adapter mirrors startup names and native `session_info_changed` events. It resolves moved pane aliases before each change.

Only the owning pane changes. Parent tabs, workspaces, and the dedicated Workers tab keep their labels.

The `pi_session_name` metadata token lets optional Agents sidebar rows display the saved Pi name. It follows automatic and manual name changes.

Empty names and shutdown clear the token. The adapter limits it to 80 Unicode code points and removes control characters.

See the [optional sidebar row](../extensions/herdr/README.md#session-names). The extension does not change Herdr configuration.

The installed Pi Software Development Kit (SDK) and Herdr passed a live test for automatic names, manual names, persistent ownership, and unchanged conversation messages.

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

### Read-only monitor panes: complete

The [Herdr extension](../extensions/herdr/README.md) opens one dedicated Workers tab per Herdr workspace. Each worker gets a separate read-only transcript pane.

The panes read existing worker records and event files:

```text
.pi/workers/records/<id>.json
.pi/workers/streams/<id>.jsonl
.pi/workers/streams/<id>.stderr.log
```

Each transcript shows captured task text, messages, recorded thinking, and complete tool text. It also shows reports and errors.

The viewer does not launch workers or change their records. Hidden provider reasoning and output that Pi omitted remain unavailable.

The existing runner continues to launch, supervise, and finalize every worker. The parent still inspects reports and collects patches through the `workers` tool.

The extension uses this monitor behavior:

1. Open one dedicated Workers tab automatically when the first monitored worker appears in a workspace.
2. Add one transcript pane per project path and worker identifier without changing keyboard focus.
3. Close successfully completed worker panes automatically. Keep failed, timed-out, and cancelled worker panes for inspection.
4. Close validated owned monitor panes when the last contributing Pi session ends.

Herdr removes the empty Workers tab. Cleanup preserves any user-added panes and their tab.

The Workers tab belongs to the contributor's workspace. Other tabs and project directories share it. Matching project paths and identifiers share a pane.

At startup, each session registers its running workers only. Historical finished workers remain excluded. Separate workspaces and Herdr servers keep separate panes.

Closing one worker pane leaves the worker running. The extension suppresses that worker's pane while other owned panes remain.

Manually closing all owned worker panes suppresses new monitors until every contributor leaves. Cleanup preserves operator-added panes.

Automatic completion cleanup does not suppress later workers. It preserves worker records, reports, and patches for the existing `workers` tool.

Monitor output remains display-only. The extension never injects it into the parent conversation.

The viewer reads bounded record, event, and standard error data once per second. It removes terminal control sequences before display.

History uses 512-kibibyte windows. A single event or worker record has an 8-mebibyte safety limit. The viewer reports oversized or unavailable data.

Earlier history remains available. Arrow keys scroll; Page keys load adjacent history. Home shows the first page; End resumes live follow.

Press `e` to switch to standard error history. Press `q` to exit only the viewer.

Pi's Markdown renderer and scrolling component format the transcript. The worker runner remains unchanged.

Parents share registration files under the Pi agent directory. A file lock protects pane creation and combined-list updates across processes.

The list contains project paths, worker identifiers, and parent process identities. It contains no worker state or output. Worker artifacts remain authoritative.

Dead parents release registration. Expired heartbeats hide output without releasing a live parent's ownership. The last contributor removes the list and pane record.

Tests cover full event replay, historical paging, live writes, terminal controls, and unchanged worker artifacts.

Ownership tests cover workspace isolation, concurrent starts, shared shutdown, individual closure, legacy migration, and tab and terminal identity checks.

A live test used separate processes and project directories in an isolated Herdr server. It verified one named Workers tab per workspace and unchanged focus.

Live tests also verified dead-parent recovery and worker survival after monitor closure. Automatic successful-completion cleanup leaves reports available in worker artifacts.

Tab cleanup tests verified removal of empty tabs and preservation of user-added panes.

Monitor panes require Linux or macOS with a compatible shell. Interactive worker launches remain deferred.

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

A Herdr plugin in [plugins/mission-board](../plugins/mission-board/README.md)
provides the first workflow action today:

| Action or pane | Behavior | Status |
| --- | --- | --- |
| Mission board | Display the project's existing mission state in a separate terminal pane | Complete |
| Open Pi | Start Pi in the selected project with its normal extension configuration | Next |
| Worker monitors | Open read-only monitor tabs for existing workers | Planned |
| Project layout | Open a layout with Pi, tests, and server logs | Planned |

The plugin ships a `herdr-plugin.toml` manifest and plain TypeScript commands
that run under strip-only Node. The **Mission board** action opens a pane
bound to the selected workspace: a split beside the focused pane when the
runtime context provides one, otherwise Herdr's default overlay. The pane
reads `<project>/.pi/missions/` through the missions extension's own storage
module, repaints once per second, and exits on `q` or Ctrl+C. It never
writes mission state.

Herdr plugins use a `herdr-plugin.toml` manifest and executable commands.
They do not require a separate software development kit.

See [Herdr plugins](https://herdr.dev/docs/plugins/) for actions, terminal panes, event hooks, and invocation context.

### Keep state ownership unchanged

Mission and worker files remain authoritative. Do not create a second task database in Herdr.

The mission board would read existing state. Any future mutation action must use an explicit, validated interface to the extension that owns that state.

Use the selected workspace's project path rather than the plugin's working directory. Herdr runs plugin commands from the plugin directory.

Call Herdr through `HERDR_BIN_PATH` when available. Pass commands as argument arrays rather than shell strings.

Track pane ownership by returned identifiers, not labels. Keep plugin configuration and runtime state outside the installed source directory.

Herdr actions must not provide an unreviewed route around Approval Mode. Define approval behavior before adding actions that execute agent-requested commands.

### Add actions incrementally

1. Add a read-only mission board pane bound to the selected workspace. Complete.
2. Add an action that opens Pi in the selected project.
3. Connect the worker viewer to plugin pane entrypoints.
4. Add an explicit project-layout action.

Check the installed Herdr capabilities before selecting the manifest's minimum version. Do not assume the latest documentation matches every installed server.

Tests must cover project-path selection, command arguments, pane ownership, and unavailable Herdr APIs.

## First implementation scope

Status metadata, blocked-dialog events, read-only worker monitors, and the
mission board plugin are complete. Worker execution remains unchanged.

Next: define section 4's Open Pi action, which starts Pi in the selected
project.
