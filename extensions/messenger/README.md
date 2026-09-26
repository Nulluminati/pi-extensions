# Messenger Extension

File-based coordination between Pi sessions sharing a project: presence, per-agent mailboxes, and path reservations that block other sessions' `edit`/`write` calls into claimed paths. No daemon. Sessions use `<project>/.pi/messenger/`; isolated workers use the parent project's directory instead of their worktree.

## Usage

```text
messenger (action=list)                          # who is online
messenger (action=send, to="swift-otter", text="auth API is changing, hold off")
messenger (action=inbox)                          # read + clear your mail
messenger (action=reserve, paths=["src/auth"], reason="refactor")
messenger (action=release)                        # drop your reservations
```

## How It Works

- **Identity**: `PI_MESSENGER_NAME` env var if set (parents spawning workers set this for stable mailbox addresses), otherwise a generated themed name persisted in the session (`messenger-identity` entry), so `pi -c` resumes under the same name without any env var and `/reload` keeps it too.
- **Presence**: each agent writes its own file under `registry/` on session start and after every settled turn. Reads merge those files and prune dead processes, regardless of each agent's worktree path. `session_shutdown` removes the current agent's entry.
- **Mailboxes**: `inbox/<encoded-name>.jsonl`, one JSON message per line. Recipient names are encoded and validated before use as filenames. Unread mail is delivered into the conversation as a custom message when the agent settles (with `triggerTurn`), then marked read. A watcher also delivers mail that arrives while the session is idle. Per-mailbox locks prevent delivery cleanup from deleting mail appended at the same time. Mailboxes survive session exit on purpose.
- **Reservations**: `reservations.json` maps path prefixes to claims, stamped with the owner's pid. Updates use a cross-process lock so concurrent reserve and release calls do not overwrite each other. A claim is rejected if it overlaps another agent's ancestor or descendant claim. A `tool_call` hook blocks `edit`/`write` calls whose target falls under another agent's prefix and tells the model who to message. Your own reservations never block you. `session_shutdown` drops only presence; claims survive so a resumed session can re-adopt them. A claim whose process and identity are gone gets a 10-minute grace window before pruning.

## Limitations

- **Worker sessions cannot send mail and cannot set free-text status**: a session spawned with `PI_WORKER=1` (the agents extension sets it) receives mail but cannot send any, and its `status` action is restricted to the bounded enum `working`, `blocked`, `waiting` (plus `""` to clear). This keeps the pull-only output boundary: worker output reaches the parent through the workers tool (`status`, `tail`) or `report_blocker`, not auto-delivered mail. Coordinate between workers through the parent.

- Reservation enforcement covers the `edit` and `write` tools only; bash-based writes are not blocked. For strong isolation run workers in a sandbox or in worktrees (the `agents` extension does the latter).
- Delivery happens when the agent is idle or at a turn boundary; mail arriving mid-turn waits until the agent settles. Workers run one-shot Pi processes. Send to a worker while it is running; mail sent after it exits remains in the mailbox, but that worker cannot read it.
- A session resumed via `pi -c` re-adopts its claims within the 10-minute grace window; after that, claims held before the quit have expired and must be re-reserved.
- Forking a session does NOT duplicate the identity: the fork detects its persisted name is held by another live process and atomically claims the next suffixed name (`name-2`, `name-3`, …) under the registry lock, so two live sessions never share presence or a mailbox. A name whose holding process is dead is reusable immediately; claims themselves survive with a 10-minute orphan grace window.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerTool("messenger")` | Presence, send, inbox, reserve/release, status |
| `pi.on("tool_call")` | Reservation enforcement for edit/write |
| `pi.on("agent_settled")` | Heartbeat + deliver unread mail into the conversation |
| `pi.sendMessage(..., { triggerTurn: true })` | Inject delivered mail as context |
| `pi.on("session_start" / "session_shutdown")` | Join/leave the mesh |
| `pi.events.emit("messenger:state")` | Publishes identity state (`{ name, unread }`); the bundled status bar subscribes and shows `✉ N` next to the context usage bar |
| `ctx.ui.setStatus("messenger", …)` | Fallback footer line (`✉ Messenger: N unread · name`) for pi's default footer; skipped by the bundled status bar, which shows the count on line 1 instead |

## Configuration

| Variable | Description |
|----------|-------------|
| `PI_MESSENGER_NAME` | Overrides the session-persisted identity; recommended for spawned workers so they get stable, predictable mailbox addresses. Without it, the identity is generated once per session and persists across `pi -c` resumes. |
| `PI_MESSENGER_PROJECT_ROOT` | Internal worker setting passed by the agents extension. Points at the absolute parent project root so workers in different worktrees share presence, mailboxes, and reservations. Invalid paths fail instead of using a worktree-local mailbox. Non-worker sessions ignore it. |

State lives in the parent project's `.pi/messenger/` for spawned workers; other sessions use their own working directory.
