# Worker Sandbox Extension

Operating-system (OS) sandbox for delegated workers and explicitly restricted main sessions. Every built-in file and shell tool (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, and `!` commands) executes inside a sandboxed child process via `@anthropic-ai/sandbox-runtime` — bubblewrap on Linux, `sandbox-exec` on macOS. A missing policy or a failed broker never falls back to host execution.

## What It Does

Active in worker sessions (`PI_WORKER=1`) and main sessions with `--sandbox '<JSON>'`. Without either, it leaves tools unchanged. On `session_start` the extension starts a per-session broker process and overrides every built-in tool with a fail-closed wrapper. Each tool call is forwarded to the broker, which spawns the call inside the sandbox under the project's policy. If the broker dies, pending and future calls reject instead of running unsandboxed.

## Main-session command line

Load this extension and `approval-mode` before passing their flags:

```bash
pi -e extensions/worker-sandbox/worker-sandbox.ts \
  -e extensions/approval-mode/approval-mode.ts \
  --approval-mode off \
  --sandbox '{
    "filesystem": {
      "allowWrite": ["/home/me/.local/state/herdboard/reviews/todb"],
      "denyWrite": ["."]
    },
    "network": {
      "allowedDomains": ["github.com", "*.github.com", "*.githubusercontent.com", "127.0.0.1:47657"]
    },
    "excludedCommands": ["terminal-browser *"]
  }'
```

Replace the review folder with an absolute path. Relative paths resolve against the session directory.
The inline policy replaces the project policy for this main session only. It does not change `.pi/sandbox.json`.
Main-session policies can grant write access outside the worktree. Empty read rules permit reads throughout the host filesystem.
The broker also grants a temporary scratch folder. Main-session tools retain the host home path for read-only configuration access.

The extension blocks other extension tools, including `background`, `monitor`, workers, and Model Context Protocol (MCP) tools.
These tools could otherwise bypass the sandbox. Use sandboxed `bash` instead.
`web_fetch` and `web_search` remain outside the sandbox.
Trusted extension lifecycle handlers and Pi itself still run on the host. Load only trusted extensions.

### Excluded commands

`excludedCommands` accepts an exact executable name or path, optionally followed by ` *`.
The wildcard permits literal arguments. It does not match a different executable or an executable through another path.
Standalone commands can use plain arguments, single-quoted arguments, or double-quoted arguments.
Single quotes make their contents literal. Double-quoted arguments cannot contain `$`, backticks, backslashes, or `!`.
For example, `terminal-browser action -- click "button.primary"` and `terminal-browser open 'https://github.com/o/r/pull/1?diff=split&tab=files'` bypass the sandbox.
Shell expansions, redirections, pipes, and command chains outside quotes keep the whole command sandboxed.
Unclosed quotes and line breaks also keep the whole command sandboxed.
The exclusion applies to `bash` and `!` commands. Excluded commands run with host permissions and the host environment.
Never exclude a general-purpose shell, interpreter, or command runner.
Workers cannot use exclusions or replace their project policy with `--sandbox`.

### Local HTTP daemons

Allow local Hypertext Transfer Protocol (HTTP) daemons explicitly in `network.allowedDomains`.
Hunk uses `127.0.0.1:47657` by default. Allow that address and port for `hunk session list` and `hunk session comment add`.
The broker preserves `HUNK_MCP_HOST` and `HUNK_MCP_PORT` in main sessions. Update the policy when these change.
Start Hunk on the host first so its daemon and authentication files exist. The sandbox cannot create files outside its write rules.
Main sessions send local HTTP requests through the filtered proxy instead of bypassing it through `NO_PROXY`.
The same domain and port rules apply. This does not grant arbitrary direct Transmission Control Protocol (TCP) access.
Clients must support the proxy environment variables. Local listening sockets and host Unix sockets remain blocked.

Bun `fetch` uses the proxy environment variables, but Bun's default `WebSocket` client ignores them.
Pass an explicit `proxy` option to Bun `WebSocket` for access through the filtered proxy.
Unmodified WebSocket clients remain blocked. Hunk's live WebSocket connection needs proxy-aware client configuration; its list and comment commands use HTTP.

## Worker policy

Rules come from the project's `.pi/sandbox.json` (srt schema: filesystem read/write rules plus `network.allowedDomains`). A read or write rule is a path, or `{ "path": "...", "literal": true }` when the name holds glob characters such as `[`, `]`, `*`, or `?`. Relative rules resolve against the worktree. The extension refuses to start when:

- The policy file is missing or malformed.
- The policy weakens isolation: unix sockets, local binding, disabled filesystem rules, or weakening flags (`allowAllUnixSockets`, `allowLocalBinding`, and friends) are refused at load and force-cleared again inside the broker as defense in depth.
- A declared write path resolves outside the worktree.

The broker grants read-only access to exact installed runtime package directories and their dependency directories.
It resolves nested versions and package links as Node does. It does not grant the enclosing `node_modules` directory.
These grants let the sandbox load Pi's tools without exposing unrelated project or credential files.
They do not add write access or weaken socket, network, or approval restrictions.
A missing required runtime package prevents sandbox startup.

## Fail-Closed Behavior

| Condition | Result |
|-----------|--------|
| Broker not ready | Tool calls throw; no host execution |
| Broker process dies | Pending and future calls reject |
| Missing or weak policy | Sandbox refuses to start; every tool call fails |
| Sandbox cannot initialize | Every tool call fails with the init error |

## Architecture

- `worker-sandbox.ts` — entrypoint: session flag, worker gate, tool overrides, `user_bash` routing.
- `src/client.ts` — request framing and lifecycle for the per-session broker connection.
- `src/policy.ts` — validates project and inline policies, refuses weakening configurations.
- `src/exclusions.mjs` — accepts standalone plain commands for explicit main-session exclusions.
- `src/broker.mjs` — the broker process: spawns sandboxed children, tracks running calls, honors cancellation.
- `src/tool-child.mjs` — the sandboxed child: executes one tool or shell request and reports the result.
- `src/git-metadata.mjs` — read-only git metadata helpers for the sandboxed environment.
- `src/runtime-paths.mjs` — exact installed runtime package directories, including transitive dependencies.

## Cross-Extension Use

`extensions/workers/src/provision/hook.ts` imports `src/client.ts` directly. Worktree provisioning runs the project's setup script inside the same sandbox as worker tools, and only this client starts that sandbox.

This import is the repository's single documented exception to keeping extensions independent. `src/client.ts` resolves `src/broker.mjs` through `import.meta.url`, so the broker must stay beside the client. Moving the pair to `lib/` would put the broker lookup at risk, so both files stay in `src/`. The test `test/extensions/worker-sandbox-client.test.ts` pins the spawned broker path to this directory.

## Platform Requirements

- Linux: `bwrap` (bubblewrap), `socat`, and `rg` on `PATH`.
- macOS: `sandbox-exec` (ships with the OS).

Runtime tests also require `curl` and Bun 1.4.2. Continuous Integration (CI) installs that Bun version.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerTool(...)` tool overrides | Routes every built-in tool through the sandbox |
| `pi.on("user_bash")` | Routes `!` commands through the sandbox |

## Related

- `extensions/workers/` — starts worker sessions with `PI_WORKER=1` and provisions the worktree this sandbox runs in.
- `.pi/sandbox.json` — this project's own policy file; see `.pi/skills/provision/SKILL.md` for the setup contract.
