# Pi Extensions

A collection of extensions for [Pi](https://pi.dev), the AI coding agent for the terminal.

## Installation

Install the entire collection:

```bash
pi install git:github.com/Nulluminati/pi-extensions
```

Or try a single extension without installing:

```bash
pi -e git:github.com/Nulluminati/pi-extensions/extensions/goal/goal.ts
```

## Extensions

| Extension | Description |
|-----------|-------------|
| `handoff/` | Summarize the current session and start a new focused session. `/handoff [goal]` builds a compact continuation prompt from the conversation, lets you review it in an editor, then opens a new session with the summary pre-filled. |
| `goal/` | Goal-oriented auto-continuation mode. `/goal` command with persistence, token budgets (`/goal budget <amount>`), pause/resume/clear, and a `goal_complete` tool. |
| `btw/` | Side conversation channel. A parallel tool-using side agent in a non-capturing overlay for mid-run questions (`/btw`), with contextual/tangent modes, hidden-from-context threading, model & thinking overrides, and full or summarized handoff back to the main agent. |
| `synthetic/` | Synthetic provider integration. Registers `synthetic` as a Pi provider with OpenAI-compatible API, dynamic model discovery, vision/reasoning support, and quota tracking via `/synthetic-models` and `/synthetic-quota`. |
| `neuralwatt/` | Neuralwatt provider integration. Registers `neuralwatt` as a Pi provider with an OpenAI-compatible API, a static model catalog (GLM-5.2, Kimi K2.5/K2.6/K2.7, Qwen3.5/3.6), a startup staleness check, and quota/energy display via `/neuralwatt-models` and `/neuralwatt-quota`. |
| `session-recap/` | Claude-Code-style session recap. Shows a one-line recap above the editor when you refocus a Pi session (via terminal focus reporting) or after idle time. Configurable triggers, flags, and `/recap` command. |
| `context7/` | Context7 documentation tools with persistent searchable cache. `context7_resolve_library_id` maps package names to Context7 IDs; `context7_get_library_docs` fetches curated docs by ID or name; `context7_get_cached_doc_raw` retrieves full raw cached docs. Optional `$CONTEXT7_API_KEY` for higher rate limits. |
| `web-search/` | Web search and fetch with a selectable provider. `web_search` tool queries the active backend (Brave, Synthetic, or a self-hosted SearXNG instance) and returns titled snippets; `web_fetch` retrieves and extracts text from any HTTP/HTTPS URL. Switch providers mid-session with `/websearch`. Brave needs `$BRAVE_API_KEY` ([get one](https://brave.com/search/api/)); Synthetic reuses the synthetic provider's credentials or `$SYNTHETIC_API_KEY`; SearXNG needs `$SEARXNG_URL` pointed at your instance. |
| `grep-app/` | Code search across public GitHub repositories via grep.app. `grep_search` tool queries millions of repos with optional filters for language, repository (`owner/repo`), and path. No API key required. |
| `lsp/` | Language-agnostic code intelligence via the Language Server Protocol. Config-driven LSP server management with auto-detection by file extension. `lsp` tool with 11 operations (diagnostics, hover, goToDefinition, findReferences, goToImplementation, documentSymbol, workspaceSymbol, prepareCallHierarchy, incomingCalls, outgoingCalls, codeActions). `/lsp` status and `/lsp-restart` commands. |
| `gondolin/` | Gondolin micro-VM sandbox. Routes all built-in tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) and `!` commands inside a QEMU micro-VM. Host cwd is mounted at `/workspace` in the guest. Requires QEMU and Node.js >= 23.6.0. |
| `status-bar/` | Starship-inspired two-line footer plus a polished input editor. Line 1 shows cwd, git branch + status block, and a right-aligned context usage bar with token breakdown and cost; line 2 shows in-flight tool progress and other extensions' status indicators. The editor is wrapped in a neutral grey frame with the model and thinking level shown on a metadata line inside. Toggle with `/statusbar`. |
| `clear/` | Aliases `/clear` to `/new` for muscle memory from Claude Code and `clear`-keyed tools. Discard confirmation is handled by the underlying `/new` behavior. |
| [`voice/`](extensions/voice/README.md) | Local dictation and speech playback with sherpa-onnx and ONNX Runtime. `/voice` opens one settings modal for dictation, speech, voice, and connection status. Hold Space to dictate; use `/voice-speak` to summarize and read the latest response aloud. |
| [`small-model/`](extensions/small-model/README.md) | One global model for handoff, BTW, session recap, and voice summaries. Use `/small-model` to select it; the current choice appears in the status bar. |

Per-extension configuration (flags, env vars, config files) lives in each extension's own `README.md` under the **Configuration** section.

## Development

### Type declarations

Extensions can import types from the `"pi"` module for IDE autocomplete and compile-time safety:

```typescript
import type { ExtensionAPI, ExtensionContext } from "pi";

export default async function (pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      ctx.ui.notify("Hello!", "info");
    },
  });
}
```

Type stubs live in `types/pi.d.ts` and cover `ExtensionAPI`, `ExtensionContext`, `ExtensionCommandContext`, `ToolDefinition`, event types, and common TUI helpers.

### Creating a new extension

Use the scaffolding script to generate boilerplate:

```bash
npm run create my-feature
```

This creates `extensions/my-feature/my-feature.ts` and `test/extensions/my-feature.test.ts`.

Or create manually:

1. Create `extensions/<descriptive-name>/` and add `<descriptive-name>.ts`
2. Implement your extension using `import type { ... } from "pi"`
3. Validate: `npm run validate:one extensions/<name>/<name>.ts`
4. Test live: `pi -e extensions/<name>/<name>.ts`
5. Format and lint: `npm run format`
6. Run full check: `npm run check`
7. Commit

### Validation

Validation logic lives in `lib/validate-extension.ts`. CLI entry points are in `scripts/`:

```bash
npm run validate          # Validate all extensions (no subprocesses)
npm run validate:one <path>  # Validate a single extension
```

Checks run on every extension:
- Valid TypeScript syntax
- Required default export (async function)
- No undeclared npm imports
- At least one pi API call (`registerTool`, `registerCommand`, `on`, `appendEntry`, or `registerProvider`)

### Secret scanning

A [gitleaks](https://github.com/gitleaks/gitleaks) config lives at `.gitleaks.toml` and runs two ways:

- The husky pre-commit hook runs `gitleaks protect --staged` so secrets are caught before they leave the machine. The hook skips silently if gitleaks isn't installed locally; install it for early feedback:
  - Fedora: `sudo dnf install gitleaks`
  - macOS: `brew install gitleaks`
- The CI workflow runs gitleaks on every push and pull request as a required check, so commits without a local install still get blocked at the server.

The config extends gitleaks' default ruleset (~150 detectors for common token formats) and allowlists documentation placeholders like `syn_...` and `ctx7sk-...`.

### Testing

Shared mock factories live in `test/mocks/`:

- `createMockPi()` — returns a mock `ExtensionAPI`
- `createMockContext()` — returns a mock `ExtensionContext`
- `createMockCommandContext()` — returns a mock `ExtensionCommandContext`
- `createMockUI()` — returns a mock `ExtensionUIContext`

Per-extension tests go in `test/extensions/<name>.test.ts`.

```bash
npm run test       # Run all tests once
npm run test:watch # Run tests in watch mode
```

### Project structure

```
pi-extensions/
├── docs/               # Product design specifications
│   └── specs/          # Per-extension product specs
├── extensions/         # Extension files
├── lib/                # Shared validation logic
├── scripts/            # CLI entry points
├── test/
│   ├── extensions/     # Per-extension tests
│   ├── mocks/          # Shared test mock factories
│   └── validator.test.ts
├── types/              # Ambient type declarations for "pi"
```

### Project scripts

| Script | Purpose |
|--------|---------|
| `npm run format` | Format all files with Biome |
| `npm run lint` | Lint all files with Biome |
| `npm run check` | Format, lint, typecheck, validate, and test |
| `npm run check:ci` | CI-friendly check (no --write, includes tests) |
| `npm run validate` | Validate all extensions |
| `npm run validate:one` | Validate a single extension |
| `npm run test` | Run all tests |
| `npm run test:watch` | Run tests in watch mode |

## Rules

- **No external npm dependencies** without explicit justification. Pi transpiles extensions directly.
- **One responsibility per file.** A focused extension is easier to test and maintain.
- **Test interactively** with `pi -e` before committing.
- **Extensions must export a default async function.**

## License

MIT
