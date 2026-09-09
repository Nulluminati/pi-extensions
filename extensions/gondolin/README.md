# Gondolin Sandbox Extension

Runs Pi's built-in file and shell tools inside a local [Gondolin](https://github.com/earendil-works/gondolin) micro-VM, with the host working directory mounted at `/workspace` in the guest.

## What It Does

This extension overrides Pi's built-in tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) and the `!` user-bash event so that, when enabled, every file read, file write, and shell command runs inside a QEMU-backed Gondolin VM. The host's current working directory is bind-mounted at `/workspace`, so edits to workspace files write through to the host while everything outside the workspace stays isolated to the guest.

It follows the "overriding built-in tools" pattern from the [official Pi extension guidelines](https://pi.dev/docs/latest/extensions), with additional logic for opt-in activation, VM lifecycle, and host/guest path translation.

## Usage

### Enable the sandbox

Start Pi with the `--gondolin` flag:

```bash
pi --gondolin
```

The first session start spins up a Gondolin VM, mounts your cwd at `/workspace`, and surfaces the VM in the footer (a `with WS <id>` segment on the status bar's first line when installed). From that point on, every built-in file or shell tool runs inside the guest.

### Check VM status

```
/gondolin
```

Shows the active VM ID, host workspace path, guest workspace path, and the shell binary detected inside the VM (`bash` when available, otherwise `/bin/sh`).

If the sandbox is not enabled, the command tells you to restart with `--gondolin`.

## How It Works

### VM lifecycle

1. **Startup** — On `session_start`, if `--gondolin` is set, the extension calls `VM.create()` from `@earendil-works/gondolin` with a `RealFSProvider` mount of the host cwd at `/workspace`. It then probes the guest for `bash` and caches the resulting shell path.
2. **Tool routing** — Every `pi.registerTool()` call wraps a local tool factory (e.g. `createReadTool(localCwd)`) and, when a VM is active, re-creates that factory with a guest-rooted cwd and custom operations backed by `vm.fs` and `vm.exec`. When the VM is not active, the wrapped tool delegates to the local factory.
3. **User bash** — A `user_bash` handler returns `createGondolinBashOps(vm, localCwd, shellPath)` so `!` and `!!` commands run inside the guest.
4. **System prompt** — A `before_agent_start` handler rewrites the "Current working directory" line so the LLM sees `/workspace` (in the VM) and the underlying host path.
5. **Shutdown** — On `session_shutdown`, the VM is closed and the status cleared.

### Path translation

The extension translates between host and guest paths in `toGuestPath()`:

- A bare relative path (e.g. `src/index.ts`) resolves under `/workspace`.
- An absolute host path inside the local cwd maps to its relative path under `/workspace`.
- An absolute host path outside the local cwd is passed through as a guest absolute path.
- A leading `@` (Pi's path-prefix syntax) is stripped before resolution.

Output paths in tool results are kept in guest form so the LLM reasons consistently about the VM's filesystem.

### Grep and find

These tools walk the guest filesystem via `walkGuestFiles()`, which mirrors the local walker's `.git` and `node_modules` skipping behavior. Glob matching uses `path.posix.matchesGlob` against the relative path so patterns like `src/**/*.ts` work without leaking host-OS path separators.

### Bash streaming

`createGondolinBashOps().exec` runs commands via `vm.exec([shellPath, "-lc", command])`, streams output chunks through `onData`, and bridges Pi's `AbortSignal` and timeout into a guest-side `AbortController`. A `timeout:N` error is thrown when the per-call timer fires before the process exits.

## Key Design Decisions

- **Opt-in via `--gondolin` flag** — Adds a boolean startup flag through `pi.registerFlag()` and gates VM creation behind `pi.getFlag("gondolin")`. The VM is only started on `session_start` when the flag is set, so users who do not pass `--gondolin` pay no startup cost and keep the standard built-in tool behavior.
- **Lazy VM creation with a shared start promise** — `ensureVm()` caches the in-flight `VM.create()` promise in a module-level `vmStarting` so concurrent tool calls during a cold start share the same VM and only one is ever created.
- **Built-in tool override pattern** — Each registered tool is a local tool factory (e.g. `createReadTool`, `createBashTool`) wrapped with a conditional `execute` that re-instantiates the factory with a custom `operations` adapter when a VM exists. This keeps the local path identical when the flag is off and avoids forking Pi's tool implementations.
- **Host/guest cwd separation** — Tools are instantiated with the guest path (`/workspace`) as the local cwd argument so the inner tool implementation stays unaware of the host. All host-to-guest translation lives in the operation adapters.
- **Status integration** — VM state changes are published on the event bus (`gondolin:vm-state`), which the status-bar extension renders as a `with WS <id>` segment on footer line 1. A `gondolin` `setStatus` entry remains as the fallback for Pi's default footer when the status bar is not installed, showing the VM ID and workspace mapping while the VM runs and clearing on shutdown.
- **Mount semantics** — Mounting the host cwd as `/workspace` (via `RealFSProvider`) means changes inside the workspace are visible on the host immediately, while changes elsewhere in the guest are discarded when the VM closes. This is a deliberate trade-off: the agent still edits your real files, but cannot tamper with anything outside the cwd.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerFlag("gondolin")` | Opt-in startup flag that gates VM creation |
| `pi.registerCommand("gondolin")` | `/gondolin` status command |
| `pi.registerTool(...)` | Overrides for `read`, `write`, `edit`, `bash`, `ls`, `find`, `grep` |
| `pi.on("session_start")` | Boots the VM on demand when the flag is set |
| `pi.on("session_shutdown")` | Closes the VM and clears the status |
| `pi.events.emit("gondolin:vm-state")` | Publishes VM state for the status bar's line 1 workspace segment |
| `pi.on("user_bash")` | Routes `!` and `!!` commands into the VM |
| `pi.on("before_agent_start")` | Rewrites the cwd line in the system prompt |
| `pi.getFlag("gondolin")` | Reads the flag at runtime per tool invocation |
| `ctx.ui.setStatus()` / `ctx.ui.theme.fg()` | Status line for VM state |
| `ctx.ui.notify()` | "VM ready" and shell-path notifications |

## Configuration

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--gondolin` | boolean | `false` | Start a Gondolin VM and route built-in tools through it |

### Requirements

- Node.js `>= 23.6.0` (for `@earendil-works/gondolin`) — checked at startup; a missing version fails loudly, never silently falls back to the host
- QEMU installed and on `PATH` (e.g. `brew install qemu` on macOS, `sudo dnf install qemu-system-x86` on Fedora) — a failed VM start records the error and every subsequent tool call fails with the QEMU hint instead of silently running on the host
- Headless-safe: json/rpc sessions (worker mode) tolerate the missing UI surface; status updates are skipped, the sandbox is not

When the flag is not set, this extension is a no-op: it registers the same tool definitions as the built-ins, the flag-gated VM is never created, and tool calls run against the host filesystem exactly as they would without the extension loaded.
