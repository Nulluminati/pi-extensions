# Herdr integration

Publish Pi extension state as display-only tokens in a Herdr pane. Herdr's official Pi integration still owns activity state and session restore.

The extension opens one dedicated `Workers` tab per Herdr workspace. Each worker gets a read-only transcript pane in that tab.

Pi sessions in the workspace share these panes. The existing worker runner still launches and controls every worker.

## Usage

1. Install the official Pi integration with `herdr integration install pi`.
2. Start Herdr in your project with `herdr`.
3. Start Pi with this repository's extensions enabled.
4. Add the desired token names to your Herdr Agent sidebar format.

For a local test, run this command inside a Herdr pane from the repository root:

```bash
pi -e extensions/herdr/herdr.ts
```

Load the corresponding source extensions to populate their tokens. Disabled source extensions leave their tokens unset.

The combined `pi_cost` token works without the status-bar extension. It uses the same shared session-cost calculation.

Herdr exposes pane tokens through `agent get`, `agent list`, `pane get`, and `pane list`. Sidebar formats refer to each token as `$name`.

For example, add these rows to your Herdr configuration:

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent", "$pi_messenger"],
  ["$pi_mission", "$pi_mission_status"],
  ["$pi_workers", "$pi_cost", "$pi_todos"],
  ["$pi_goal"],
]
```

Replace an existing `ui.sidebar.agents` section rather than adding a duplicate section.

If your sidebar already uses `$pi_worker_cost`, replace it with `$pi_cost` to display the combined total.

See [Herdr metadata reporting](https://herdr.dev/docs/socket-api/#agent-state-reporting) for the display contract.

## Session names

The adapter copies the current Pi session name onto its owning Herdr pane at startup. It follows native Pi name-change events.

Enable the [session-name extension](../session-name/README.md) for temporary project names and first-message topic names from the global small model.

Manual Pi names also reach the pane. An unnamed startup session does not erase an existing Herdr label.

The adapter also publishes the saved name as `pi_session_name`. Herdr's Agents sidebar does not display pane labels automatically.

To display the saved Pi name, add this optional row to your existing `ui.sidebar.agents.rows` array:

```toml
["$pi_session_name"],
```

The token follows temporary names, generated names, and manual `/name` changes. Empty names and shutdown clear the token.

The adapter normalizes whitespace, removes control characters, and limits this token to 80 Unicode code points. It leaves the saved Pi name unchanged.

Session names are visible to Herdr metadata readers. Do not include sensitive text in a name.

The extension does not edit your Herdr configuration.

The adapter resolves the owning pane's canonical identifier after a move. It never renames parent tabs, workspaces, or the `Workers` tab.

Name changes do not wait for socket responses. Rapid changes use the latest pending name. Shutdown cancels pending requests.

The adapter clears a pane label only after it set a name during the active session. Name failures produce one warning per failure episode.

## Tokens

| Token | Source event | Value |
| --- | --- | --- |
| `pi_session_name` | Session startup and `session_info_changed` | Saved Pi session name, limited to 80 Unicode code points |
| `pi_mission` | `missions:state` | Active mission title |
| `pi_mission_status` | `missions:state` | Mission status |
| `pi_workers` | `workers:state` | Running worker count |
| `pi_cost` | Session lifecycle and `workers:state` | Main-session cost plus worker cost in dollars, with three decimal places |
| `pi_worker_cost` | `workers:state` | Worker-only cost in dollars, with four decimal places |
| `pi_worker_tokens` | `workers:state` | Worker token total |
| `pi_todos` | `todos:changed` | Completed tasks divided by total tasks, such as `2/5` |
| `pi_goal` | `goal:state-change` | Goal status and iteration, such as `active 3/25` |
| `pi_messenger` | `messenger:state` | Session's messenger name |
| `pi_unread` | `messenger:state` | Unread message count |

The adapter normalizes metadata text and limits it to 80 characters. It ignores malformed metadata events. It never publishes prompts, command text, worker reports, or credentials.

The combined cost includes provider-reported usage on the active session branch and the worker total published by the workers extension.

Session usage includes assistant messages, tool results, standalone usage, compaction, and branch summaries. Nested tool usage contributes through its top-level tool result only.

The adapter adds unrounded session and worker costs before formatting the total. Without worker usage, `pi_cost` matches Pi's main cost display.

## Lifecycle

The adapter captures event announcements before session startup. It opens sockets and starts timers only after an interactive session starts.

Updates use `pane.report_metadata` with source `pi-extensions:herdr`. The adapter combines changes over 50 milliseconds and sends requests sequentially.

Tokens expire after 60 seconds. The adapter refreshes them every 20 seconds. Sequence numbers protect against out-of-order reports from this source.

The adapter restores session cost at startup. Message and turn completion schedule cost updates. Worker updates and periodic refreshes also recalculate the combined total.

Shutdown cancels pending updates, removes event listeners, and clears the adapter's tokens. If Herdr is unavailable, expiry removes stale values.

A metadata socket request has a one-second timeout and a 64-kibibyte response limit. Monitor requests have a five-second timeout. Metadata and pane names track separate failure episodes. Each produces at most one warning before recovery. It retries on a later update or refresh.

## Blocked dialogs

The repository's `ask-user` and `approval-mode` extensions emit `herdr:blocked` while an interactive dialog waits for input.

Each opened dialog emits one active event and one clearing event. Completion, cancellation, and errors all clear the event. Queued approval requests do not count as opened dialogs.

The official Herdr Pi integration consumes these events. Version 9 supports this contract. Install or update that integration if blocked dialogs do not appear in Herdr.

The metadata adapter does not report agent activity itself. Blocked-dialog events also work without this adapter when the official integration is loaded.

## Worker monitors

The first monitored worker opens a dedicated tab named `Workers` in its parent's workspace. Later workers get separate panes in that tab.

After an extension update:

1. Reload each contributing Pi session with `/reload`.
2. Wait for those reloads before you launch another worker.

Existing monitor processes keep their loaded viewer code until replacement.

The extension does not change keyboard focus or split the parent's pane.

Other Pi sessions in the workspace share the tab, including sessions in other project directories. Other workspaces remain separate.

The project path and worker identifier determine pane identity. Two sessions that monitor the same project worker use the same pane.

Sessions share through the same Pi agent directory on the same host. Separate Herdr servers do not share panes.

Each session registers its running workers at startup. It does not add historical finished workers.

Each pane reads existing worker records, event streams, and standard error (`stderr`). It shows captured task text, messages, and recorded thinking.

Tool arguments, text results, result details, reports, and errors remain complete within the explicit safety limits below. Streaming snapshots replace earlier snapshots.

The transcript uses Pi's Markdown renderer and scrolling component. Thinking uses dim text. Tool headings show success or failure.

Colors use the terminal's palette. The view wraps long text rather than replacing it with summary cards.

The viewer cannot show hidden provider reasoning or output that Pi never recorded. It does not render image messages.

Redirected output remains text. It includes the current bounded history page, with a notice when older history exists.

Successful completion automatically closes the worker's owned transcript pane. Failed, timed-out, and cancelled workers remain visible for inspection.

Worker records, reports, and patches remain available through the `workers` tool. The extension does not delete artifacts or collect patches.

Automatic closure does not suppress panes for later workers. Cleanup validates pane identity and preserves operator-added panes. Removed workers leave the view.

Focus a worker's pane to use these controls:

| Key | Action |
| --- | --- |
| Up/Down | Scroll one line |
| Page Up/Page Down | Scroll a screen; load adjacent history at page boundaries |
| Home | Show the oldest recorded page |
| End | Return to the newest output and follow live updates |
| `e` | Switch between the transcript and complete `stderr` history |
| `q` or Ctrl+C | Exit the viewer without cancelling the worker |

Scroll upward to pause live follow. Press End to resume it.

Herdr's pane controls close the pane. Closing one pane suppresses that worker's monitor while other owned panes remain.

Manually closing all owned worker panes suppresses new monitors until every contributing Pi session leaves. Operator-added panes do not change that rule.

Pi shutdown removes that session's registration. Other sessions keep the shared tab. The last contributing session closes all validated owned monitor panes.

Herdr removes the tab when it becomes empty. If you add another pane, cleanup preserves that pane and the tab.

Worker shutdown remains the existing runner's responsibility. Cleanup checks server, workspace, tab, and terminal identities before it closes an owned pane.

The viewer refreshes once per second. Each pane follows its worker's newest output unless you scroll into history.

History reads use 512-kibibyte windows. A large event can expand a window to 8 mebibytes. Earlier pages remain available through the scroll controls.

Worker records have an 8-mebibyte read limit. Oversized events and unavailable records produce visible notices rather than silent summaries.

The viewer handles incomplete JSON lines and UTF-8 characters across live writes. It refuses symbolic links and non-regular artifact files.

It removes terminal control sequences before display. It never writes worker artifacts or injects output into the conversation.

Each parent registers its project path and monitored worker identifiers under `<agentDir>/herdr/workspaces/`. Registration files include process identities and heartbeat times.

A file lock protects shared updates and pane creation. Atomic writes prevent partial lists. The viewer reads at most 64 kibibytes from the combined list.

Parents refresh registration every 20 seconds. The viewer hides expired registrations after 60 seconds. Dead parents release ownership; delayed live parents retain ownership.

The list contains no worker status, reports, or prompts. Worker records and streams remain authoritative. The last contributor removes the list and pane record.

Monitor creation uses Herdr's socket Application Programming Interface (API). The extension tracks returned pane, workspace, tab, and terminal identifiers, not labels.

Each creation attempt enters the ownership record before the socket mutation. A failed launch shows a warning and suppresses that worker's automatic retry.

This avoids duplicate panes after an uncertain response. Other workers can still open through a surviving validated pane.

A validated legacy shared monitor can migrate within its tab. The extension starts its replacement transcript pane before it closes the legacy pane.

Monitor panes require Linux or macOS with a shell that supports POSIX quoting and `exec`. They use Pi's Node.js runtime, version 22.19 or later.

Windows still supports metadata reporting, but not monitor panes.

## Configuration

There is no adapter configuration file or command.

| Variable | Requirement |
| --- | --- |
| `HERDR_ENV` | Must equal `1` |
| `HERDR_SOCKET_PATH` | Must identify the Herdr socket |
| `HERDR_PANE_ID` | Must identify the current pane |
| `PI_WORKER` | Must not equal `1` |

Herdr supplies its environment variables. The adapter remains inactive outside Herdr, without a terminal interface, or in a worker session.

Remote Procedure Call (RPC), JSON, and print modes do not report metadata. Inherited parent-pane identifiers never permit a headless worker to report as its parent.

Herdr supports Unix sockets and Windows named pipes. The adapter adds no external dependencies.
