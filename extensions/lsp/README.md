# LSP Code Intelligence Extension

Language-agnostic code intelligence via the Language Server Protocol. Config-driven — you define LSP servers in JSON, and the extension picks the right one from the file extension.

## What It Does

Registers a single LLM-callable tool — `lsp` — that wraps eleven standard LSP operations behind a uniform interface:

| Operation | What it does | Where you point it |
|-----------|--------------|--------------------|
| `diagnostics` | Errors, warnings, hints for a file | a file path |
| `hover` | Type info and docs at a position | a file path + line + column |
| `goToDefinition` | Where a symbol is defined | a file path + line + column |
| `findReferences` | Every use of a symbol | a file path + line + column |
| `goToImplementation` | Concrete implementations of an interface/abstract | a file path + line + column |
| `documentSymbol` | The symbols defined in a file | a file path |
| `workspaceSymbol` | All symbols matching a name | a query string |
| `prepareCallHierarchy` | The function/method at a position | a file path + line + column |
| `incomingCalls` | Callers of a function | a file path + line + column |
| `outgoingCalls` | What a function calls | a file path + line + column |
| `codeActions` | Available quick-fixes and refactors at a line | a file path + line |

Two slash commands are also registered:

- `/lsp` — shows which servers are configured, which are running, and any config errors
- `/lsp-restart` — stops every server; they reinitialize on the next tool call

The extension is config-driven: it doesn't ship with any default servers. You tell it which binaries to run for which file types, and it spawns and manages them on demand.

## Usage

The agent calls the tool when it needs code intelligence:

```
lsp({ operation: "hover", filePath: "src/auth.ts", line: 42, character: 8 })
lsp({ operation: "diagnostics", filePath: "src/auth.ts" })
lsp({ operation: "workspaceSymbol", query: "Handoff" })
```

If the requested file maps to a configured server, the extension spawns the server (if it isn't running), opens the document, sends the request, and returns a formatted text result. Multiple servers can handle the same file — the extension calls them all and merges diagnostics by source.

### Check status

```
/lsp
```

Reports the configured servers, their status (running vs available), the extensions each one handles, and any errors from the config files.

### Restart servers

```
/lsp-restart
```

Shuts down every running server. The next tool call reinitializes whichever server is needed.

## How It Works

### Config loading

The extension reads server definitions from two JSON files, layered:

1. **Global** — `~/.pi/agent/extensions/lsp/config.json` applies to every project
2. **Project** — `.pi/lsp.json` in the project root overrides the global file

A global `lsp: false` disables all servers in a project without editing the global file. Each server entry takes:

```json
{
  "lsp": {
    "typescript": {
      "command": ["npx", "-y", "typescript-language-server", "--stdio"],
      "extensions": [".ts", ".tsx", ".js", ".jsx"],
      "env": {},
      "initialization": {}
    }
  }
}
```

Per-server overrides let a project swap the global binary (for example, pinning a specific language server version) without losing the global file. Config errors don't crash — they're collected and surfaced through `/lsp`.

### Server lifecycle

1. **Cold start** — The first tool call for an operation on a file triggers server resolution. If the matching server isn't running, the extension spawns it (using `node:child_process.spawn`) and waits for the `initialize` handshake to complete.
2. **Document open** — Before serving position-based operations, the extension opens the file with the server (`textDocument/didOpen`) and waits for any pending diagnostics to settle. Newer servers that ship native pull diagnostics are still worked with via a `resyncDocument` helper that triggers a publishDiagnostics cycle.
3. **Reuse** — The running server is kept alive for the rest of the session. Subsequent calls for any of its operations reuse the same connection.
4. **Restart** — `/lsp-restart` shuts down every server cleanly (sends `shutdown` and `exit` notifications, then kills the process). Next tool call reinitializes.
5. **Session end** — `session_shutdown` disposes every connection with the same shutdown sequence.

### Operation dispatch

Each operation goes through a single `execute` function that validates parameters, picks the right server, opens the file when needed, runs the request, and formats the response. Position-based operations require `filePath`, `line`, and `character`; file-based ones need only `filePath`; the workspace symbol lookup takes a `query` string. The extension retries transient failures (a few of the operations are worth retrying) on a short delay before giving up.

### Path and URI handling

Files are passed between the extension and servers as `file://` URIs. The extension normalizes platform-specific path forms (Windows drive letters, percent-encoded characters) so positions and ranges line up regardless of host.

### Diagnostics

Diagnostics flow from `textDocument/publishDiagnostics` notifications into a per-URI store with a small wait window — the server gets a few seconds to publish before the tool returns, so the LLM doesn't see a partial result. When several servers report on the same file, results are grouped by source.

## Key Design Decisions

- **Config-driven, not curated** — The extension is a transport, not a catalog. It doesn't ship with typecheckers or language servers; you wire up whatever you need. New languages and servers can be added by editing JSON, no code changes.
- **One tool, many operations** — A single `lsp` tool with an `operation` discriminator is cleaner than eleven separate tools from the agent's perspective. The schema is uniform, the routing is centralized, and the LLM only has to learn one name.
- **No default servers** — Pinning a default would force opinions on which binaries to use. Leaving it empty means the user controls the stack and never runs a server they didn't ask for.
- **Layered config** — A global file covers personal defaults; a project file overrides per-repo. The `lsp: false` escape hatch disables everything without deleting config.
- **Retry only where it pays** — Position-based lookups occasionally race a slow server startup, so they get a short retry. Diagnostics and code actions either work first try or fail loudly — retrying there just hides real errors.
- **Status line integration** — A Nerd Font code-braces icon with a "lsp" label appears in the status bar while servers are running, so you can see at a glance whether anything is alive.
- **Bounded output** — Workspace symbol results are capped to a few dozen entries, with a "(showing N of M)" footer when the cap kicks in. Unbounded symbol dumps would drown the LLM.

## Pi APIs Used

| API | Purpose |
|-----|---------|
| `pi.registerTool("lsp")` | The single LLM-callable tool covering all operations |
| `pi.registerCommand("lsp")` | Status command |
| `pi.registerCommand("lsp-restart")` | Restart command |
| `pi.on("session_start")` | Loads config and surfaces the status line |
| `pi.on("session_shutdown")` | Disposes every running server |
| `ctx.ui.notify()` | Status, error, and restart feedback |
| `ctx.ui.setStatus()` | Persistent status indicator |
| `ctx.ui.theme.fg()` | Colors the status icon and label |
| `ctx.cwd` | The project root for config lookup and path resolution |

> Server processes are spawned directly via `node:child_process.spawn`, not through `pi.exec()`. The extension manages its own stdio JSON-RPC framing.

## Configuration

### Per-project

Create `.pi/lsp.json` in the project root:

```json
{
  "lsp": {
    "typescript": {
      "command": ["npx", "-y", "typescript-language-server", "--stdio"],
      "extensions": [".ts", ".tsx", ".js", ".jsx"]
    },
    "pyright": {
      "command": ["pyright-langserver", "--stdio"],
      "extensions": [".py", ".pyi"]
    }
  }
}
```

Set `"lsp": false` to disable all servers in this project without touching the global file.

### Global

Create `~/.pi/agent/extensions/lsp/config.json` with the same shape to define servers available to every project. Per-project files override the global one.

### Per-server fields

| Field | Type | Description |
|-------|------|-------------|
| `command` | `string[]` | The binary and its arguments (run as-is) |
| `extensions` | `string[]` | File extensions this server handles (with the leading dot) |
| `env` | `Record<string, string>` | Extra environment variables for the server process |
| `initialization` | `object` | The `initializationOptions` sent during the LSP handshake |
| `disabled` | `boolean` | Skip this server (in a project file, suppresses the global definition) |

The extension bundles a small language-id map for common extensions (TypeScript, Python, Rust, Go, Zig, and others) and falls back to `plaintext` for anything it doesn't recognize.
