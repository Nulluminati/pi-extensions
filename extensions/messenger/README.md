# Messenger Extension

File-based coordination between Pi sessions sharing a project: presence, per-agent mailboxes, and path reservations that block other sessions' `edit`/`write` calls into claimed paths. No daemon — all state lives under `<cwd>/\.pi/messenger/`.

## Usage

```text
messenger (action=list)                          # who is online
messenger (action=send, to="swift-otter", text="auth API is changing, hold off")
messenger (action=inbox)                          # read + clear your mail
messenger (action=reserve, paths=["src/auth"], reason="refactor")
messenger (action=release)                        # drop your reservations
```

## How It Works

- **Identity**: `PI_MESSENGER_NAME` env var if set (parents spawning workers set this for stable mailbox addresses), otherwise a generated themed name per process.
- **Presence**: `registry.json` heartbeat on session start and every settled turn; dead pids are pruned on read; `session_shutdown` removes your entry.
- **Mailboxes**: `inbox/<name>.jsonl`, one JSON message per line. Unread mail is delivered into the conversation as a custom message when the agent settles (with `triggerTurn`), and marked read. An inbox watcher also delivers immediately when mail arrives while the session is idle — a session that is open but never prompted still gets its mail. Mailboxes survive session exit on purpose.
- **Reservations**: `reservations.json` maps path prefixes to claims, stamped with the owner's pid. A `tool_call` hook blocks `edit`/`write` calls whose target falls under another agent's prefix (directory-boundary matching) and tells the model who to message. Your own reservations never block you. Claims are pruned on read when the owning process is gone and its identity has left the registry, so a crashed session's claims expire instead of blocking forever. With a stable identity (`PI_MESSENGER_NAME`), claims survive a restart (`pi -c`) and are re-adopted on session start; generated names release their claims on shutdown since a restarted session cannot re-adopt them.

## Limitations

- Reservation enforcement covers the `edit` and `write` tools only; bash-based writes are not blocked. For strong isolation run workers in a sandbox or in worktrees (the `agents` extension does the latter).
- Delivery always happens at a turn boundary — mail arriving mid-turn waits for the agent to settle; it is never injected into an in-flight request. Mail to an agent in a different project directory waits in their mailbox there.
- Reservation survival across restarts requires `PI_MESSENGER_NAME`; with a generated name, restarting always starts a new identity with no claims.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerTool("messenger")` | Presence, send, inbox, reserve/release, status |
| `pi.on("tool_call")` | Reservation enforcement for edit/write |
| `pi.on("agent_settled")` | Heartbeat + deliver unread mail into the conversation |
| `pi.sendMessage(..., { triggerTurn: true })` | Inject delivered mail as context |
| `pi.on("session_start" / "session_shutdown")` | Join/leave the mesh |

## Configuration

| Variable | Description |
|----------|-------------|
| `PI_MESSENGER_NAME` | Stable agent identity (recommended for spawned workers). Also preserves reservations across restarts: the restarted session re-adopts the claims held under the same name. |

State lives in `<cwd>/.pi/messenger/`.
