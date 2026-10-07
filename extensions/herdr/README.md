# Herdr integration

Publish Pi extension state as display-only tokens in a Herdr pane. Herdr's official Pi integration still owns activity state and session restore.

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

The adapter resolves the owning pane's canonical identifier after a move. It never renames parent tabs or workspaces.

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

A metadata socket request has a one-second timeout and a 64-kibibyte response limit. Metadata and pane names track separate failure episodes. Each produces at most one warning before recovery. It retries on a later update or refresh.

## Blocked dialogs

The repository's `ask-user` and `approval-mode` extensions emit `herdr:blocked` while an interactive dialog waits for input.

Each opened dialog emits one active event and one clearing event. Completion, cancellation, and errors all clear the event. Queued approval requests do not count as opened dialogs.

The official Herdr Pi integration consumes these events. Version 9 supports this contract. Install or update that integration if blocked dialogs do not appear in Herdr.

The metadata adapter does not report agent activity itself. Blocked-dialog events also work without this adapter when the official integration is loaded.

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
