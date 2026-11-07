# Herdr integration

The integration provides status metadata, session names, and blocked-dialog events. It does not create mission or worker boards.

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

Only the owning pane changes. Parent tabs and workspaces keep their labels.

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

### Program status: complete

Pi 1.5.0 reports blocked state to terminals through the Program Status Protocol (OSC 7501). Herdr does not need this protocol because it uses `herdr:blocked`. Other terminals, such as Rex and iTerm2, do.

The inline dialogs pass `blocked: { kind, message }` to `ctx.ui.custom()`. Without this option Pi reports the session as working while a dialog waits for an answer.

| Dialog | Helper | Kind |
|--------|--------|------|
| `ask_user` questionnaire | `showQuestionnaire` | `question` |
| Confirmation modal | `confirmModal` | `permission` |
| Text prompt | `promptText` | `question` |
| Model picker | `selectModelWithSearch` | `question` |

Pi ignores the option for overlays. These panels are overlays, so they keep the Herdr event only:

- The `approval-mode` approval dialog. It is a focused overlay, and fullscreen viewports consume page keys unless an overlay is focused.
- The `background-jobs`, `context`, `todos`, and `btw` panels.

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

The adapter reports worker counts and usage as metadata only. It does not open worker panes or maintain a viewer registry.

Inspect reports and collect patches through the existing `workers` tool. Worker artifacts remain authoritative.

### Worker launch safeguards

A plain `herdr agent start --kind pi` does not preserve our approval connection or worker lifecycle.

Any launch adapter must preserve:

- Mandatory worker extensions and their restrictions.
- Sandbox policy and worktree provisioning.
- Worker-model enforcement.
- Parent approval requests and live approval-mode changes.
- Durable output, timeouts, cancellation, and patch collection.

Herdr [does not sandbox plugin code](https://herdr.dev/docs/plugins/#trust-and-security). A separate worktree does not provide permission isolation.

Keep the current worker runner as the default. Do not replace it as part of the status adapter.
