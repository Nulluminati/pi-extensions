# Worker Sandbox Extension

OS-level sandbox for delegated worker sessions. Every built-in file and shell tool (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, and `!` commands) executes inside a sandboxed child process via `@anthropic-ai/sandbox-runtime` — bubblewrap on Linux, `sandbox-exec` on macOS. A missing policy or a failed broker never falls back to host execution.

## What It Does

Loaded only in worker sessions (`PI_WORKER=1`). On `session_start` the extension starts a per-session broker process and overrides every built-in tool with a fail-closed wrapper. Each tool call is forwarded to the broker, which spawns the call inside the sandbox under the project's policy. If the broker dies, pending and future calls reject instead of running unsandboxed.

## Policy

Rules come from the project's `.pi/sandbox.json` (srt schema: filesystem read/write rules plus `network.allowedDomains`). A read or write rule is a path, or `{ "path": "...", "literal": true }` when the name holds glob characters such as `[`, `]`, `*`, or `?`. Relative rules resolve against the worktree. The extension refuses to start when:

- The policy file is missing or malformed.
- The policy weakens isolation: unix sockets, local binding, disabled filesystem rules, or weakening flags (`allowAllUnixSockets`, `allowLocalBinding`, and friends) are refused at load and force-cleared again inside the broker as defense in depth.
- A declared write path resolves outside the worktree.

## Fail-Closed Behavior

| Condition | Result |
|-----------|--------|
| Broker not ready | Tool calls throw; no host execution |
| Broker process dies | Pending and future calls reject |
| Missing or weak policy | Sandbox refuses to start; every tool call fails |
| Sandbox cannot initialize | Every tool call fails with the init error |

## Architecture

- `worker-sandbox.ts` — entrypoint: worker-session gate, tool overrides, `user_bash` routing.
- `src/client.ts` — request framing and lifecycle for the per-session broker connection.
- `src/policy.ts` — loads and validates `.pi/sandbox.json`, refuses weakening configurations.
- `src/broker.mjs` — the broker process: spawns sandboxed children, tracks running calls, honors cancellation.
- `src/tool-child.mjs` — the sandboxed child: executes one tool or shell request and reports the result.
- `src/git-metadata.mjs` — read-only git metadata helpers for the sandboxed environment.

## Cross-Extension Use

`extensions/workers/src/provision/hook.ts` imports `src/client.ts` directly. Worktree provisioning runs the project's setup script inside the same sandbox as worker tools, and only this client starts that sandbox.

This import is the repository's single documented exception to keeping extensions independent. `src/client.ts` resolves `src/broker.mjs` through `import.meta.url`, so the broker must stay beside the client. Moving the pair to `lib/` would put the broker lookup at risk, so both files stay in `src/`. The test `test/extensions/worker-sandbox-client.test.ts` pins the spawned broker path to this directory.

## Platform Requirements

- Linux: `bwrap` (bubblewrap), `socat`, and `rg` on `PATH`.
- macOS: `sandbox-exec` (ships with the OS).

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerTool(...)` tool overrides | Routes every built-in tool through the sandbox |
| `pi.on("user_bash")` | Routes `!` commands through the sandbox |

## Related

- `extensions/workers/` — starts worker sessions with `PI_WORKER=1` and provisions the worktree this sandbox runs in.
- `.pi/sandbox.json` — this project's own policy file; see `.pi/skills/provision/SKILL.md` for the setup contract.
