# Agent Instructions for pi-extensions

## Context

This repo is a **published collection of Pi extensions** — standalone TypeScript modules that add tools, slash commands, and behaviors to the Pi AI coding agent. It is not a personal dotfiles repo and should not be treated as a pi agent directory.

## When working in this repo

### Creating a new extension

1. Create `extensions/<descriptive-name>/` and add `<descriptive-name>.ts`
2. Follow the **code conventions** below for structure and style
3. Fill in the implementation
4. Add tests in `test/extensions/<descriptive-name>.test.ts`
5. Run the validator: `npm run validate:one extensions/<name>/<name>.ts`
6. Test live: `pi -e extensions/<name>/<name>.ts`
7. Add a section to `README.md` describing what the extension does
8. Run `npm run check` to ensure everything passes format, lint, typecheck, validation, and tests
9. Commit

### Modifying an existing extension

1. Edit the `.ts` file
2. Update tests if behavior changed
3. Run the validator
4. Test live with `pi -e`
5. Run `npm run check`
6. Commit

### Rules

- **Do not add external npm dependencies without asking first.** Pi transpiles extensions directly.
- **Keep extensions stateless where possible.** If state is needed, use a clear persistence strategy (see State Management below).
- **Extensions must export a default async function.**
- **Run `npm run format` before committing** to keep Biome formatting consistent.
- **Never use non-null assertions (`!`).** Use proper null checks or pass validated values as parameters.
- **Update `types/pi.d.ts` when using runtime APIs not in the stubs.** See Type Declarations below.

---

## Code Conventions

### File structure

Every extension file should follow this order. Sections are marked with `// --- Name ---` banner comments; small files may only need the `// --- Extension ---` banner before the default export.

```typescript
/**
 * Extension Name
 *
 * Short description of what this extension does.
 */

// --- Imports ---
import type { ExtensionAPI, ExtensionCommandContext } from "pi";
// External runtime modules (if needed):
// import { something } from "@earendil-works/pi-ai";

// --- Constants ---
const MAX_LENGTH = 2000;
const WIDGET_KEY = "my-ext";

// --- Types ---
interface MyExtState {
  active: boolean;
}

// --- Helpers ---
function helper(value: string): string {
  return value.trim();
}

// --- Extension ---
export default async function myExtension(pi: ExtensionAPI) {
  // Implementation
}
```

### Import ordering

1. External runtime modules (e.g., `@earendil-works/pi-ai`)
2. `import type { ... } from "pi"`
3. Extension-relative imports (none in this repo — extensions are self-contained)

### Naming conventions

| Thing | Convention | Example |
|-------|-----------|---------|
| Constants | `UPPER_SNAKE_CASE` | `MAX_QUESTION_LENGTH` |
| Types | `PascalCase` | `BtwState`, `MessageContentBlock` |
| Functions | `camelCase` | `buildUserPrompt`, `formatBranchContext` |
| File name | `kebab-case` matching extension name | `btw.ts`, `goal.ts` |
| Widget keys | `kebab-case` | `"btw"`, `"goal"` |
| Custom entry types | `kebab-case` | `"goal-state"`, `"btw-question"` |

Slash commands use the extension name with subcommands namespaced by a colon (`goal:new`, `btw:inject`, `voice:settings`). The command prefix may drop hyphens for typeability (`web-search` → `/websearch:select`, `status-bar` → `/statusbar:toggle`, `small-model` → `/smallmodel`) or use a shorter verb when the extension name is long (`session-recap` → `/recap`). New extensions should prefer the full extension name as the prefix unless it is awkward to type.

### Error handling

- **Never swallow errors silently.** Always handle or propagate.
- **Use `ctx.ui.notify(message, "error")` for user-visible errors.**
- **For async errors in `ui.custom` factories, pass the error string to `done()` so the user sees it in the dialog.**
- **Validate preconditions early** (empty args, missing model, no UI) and return before doing work.
- **Guard TUI-only command handlers with `if (!ctx.hasUI) return;` at the top of the handler.** Do not wrap `ctx.ui.notify` in a helper that falls back to `console.*` — in `rpc`/`json`/`print` mode a command that cannot work should do nothing, explicitly.

---

## State Management

Extensions should minimize state. Choose the right strategy:

### Stateless (preferred)

Use when all data fits in a single command handler or is passed through function parameters.

**Example: `/btw`** — all state lives in the `ui.custom` closure. No module-level variables.

### Per-instance state (WeakMap)

Use when the extension needs to track transient state across event handlers for a single Pi instance, but not persist across sessions.

```typescript
const stateMap = new WeakMap<ExtensionAPI, MyState | null>();
const timerMap = new WeakMap<ExtensionAPI, ReturnType<typeof setTimeout> | null>();

function getState(pi: ExtensionAPI): MyState | null {
  return stateMap.get(pi) ?? null;
}
```

**Example: old `/btw` before rewrite** — used WeakMap to track pending questions and timers.

### Persistent state (`appendEntry`)

Use when state must survive across sessions, reloads, or agent restarts.

```typescript
pi.appendEntry("my-state", { data: myData });
```

On `session_start`, reconstruct state from `ctx.sessionManager.getBranch()`:

```typescript
pi.on("session_start", async (_event, ctx) => {
  const entry = ctx.sessionManager
    .getBranch()
    .find((e) => e.type === "custom" && e.customType === "my-state");
  if (entry) {
    restoreState(entry.data);
  }
});
```

**Example: `/goal`** — stores goal state via `appendEntry("goal-state", ...)` and reconstructs on session start.

### Module-level variables (avoid if possible)

Module-level `let` is the weakest pattern — state leaks across tests and Pi instances. If you must use it, always clear on `session_start` or `session_shutdown`.

---

## Type Declarations

The `types/pi.d.ts` file contains ambient type declarations for Pi's runtime APIs. If your extension uses runtime APIs not in the stubs, **update the declarations** so `tsc --noEmit` passes.

### When to update

- Importing from `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, or other runtime modules
- Using `ctx.modelRegistry` methods not declared
- Using `ctx.model` properties not declared
- Using `ui.custom` factories with parameter types not declared

### How to update

Add minimal declarations to the relevant module block:

```typescript
declare module "@earendil-works/pi-ai" {
  export function complete(model: any, payload: any, options: any): Promise<any>;
  export interface UserMessage {
    role: "user";
    content: Array<{ type: string; text: string }>;
    timestamp: number;
  }
}
```

Keep declarations loose (`any` for complex nested types) unless you know the exact runtime shape. The goal is TypeScript compilation, not perfect typing.

---

## Testing

### Test file location and structure

```typescript
// test/extensions/<name>.test.ts
import { describe, expect, it, vi } from "vitest";
import myExtension from "../../extensions/<name>/<name>.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";

describe("<name>-extension", () => {
  // tests here
});
```

### What to test

1. **Registration tests** — verify `registerCommand`, `registerTool`, `registerMessageRenderer`, and `on` are called with correct arguments.
2. **Command handler tests** — test every branch (empty args, too long, valid input, special keywords).
3. **Tool execution tests** — assert the full result shape (`content`, `details`, `terminate`).
4. **Event handler tests** — extract handlers with `getEventHandler` and simulate events.
5. **Lifecycle tests** — for stateful extensions, test state transitions (start → pause → resume → clear).
6. **Error path tests** — auth failures, missing models, timeout, cancellation.
7. **Context tests** — verify `sessionManager.getBranch()` data is used correctly.

### Mock patterns

**Create fresh mocks per test.** Never reuse mock instances across tests.

```typescript
it("does something", async () => {
  const mockPi = createMockPi();
  const mockCtx = createMockCommandContext();
  await myExtension(mockPi);
  // ... test
});
```

**Override mock behavior inline** for test-specific needs:

```typescript
mockCtx.sessionManager.getBranch = () => [
  { role: "user", content: "hello" },
];
```

**Mock external runtime modules** with `vi.mock()` at the top of the test file:

```typescript
vi.mock("@earendil-works/pi-ai", () => ({
  complete: vi.fn(),
}));
```

**Reset module-level mocks between tests** with `beforeEach`:

```typescript
beforeEach(() => {
  vi.resetAllMocks();
});
```

**For `ui.custom` tests**, provide a mock that executes the factory and resolves when `done` is called:

```typescript
mockCtx.ui.custom = vi.fn((factory: any) => {
  return new Promise((resolve) => {
    const done = resolve;
    const theme = {
      fg: (_c: string, text: string) => text,
      bold: (text: string) => text,
      dim: (text: string) => text,
      // ... other theme methods
    };
    const component = factory(null, theme, null, done);
    // Auto-resolve modal dialogs so tests don't hang
    if (component.handleInput) {
      setTimeout(() => done(undefined), 0);
    }
  });
});
```

### Test naming

Use descriptive names that explain behavior, not implementation:

```typescript
// Good
it("/goal pause pauses active goal", ...);
it("goal_complete tool errors when no active goal", ...);

// Bad
it("test pause", ...);
it("test goal_complete", ...);
```

### Helper functions

Place test helpers **after** the `describe` block, at the bottom of the file:

```typescript
describe("my-extension", () => {
  // ... tests
});

function getEventHandler(mockPi: any, eventType: string): (...args: any[]) => any {
  const calls = mockPi.on.mock.calls;
  for (const call of calls) {
    if (call[0] === eventType) return call[1];
  }
  throw new Error(`Handler for ${eventType} not found`);
}
```

### Extracting event handlers

Use a helper like `getEventHandler` to find registered handlers by event type:

```typescript
const handler = getEventHandler(mockPi, "message_end");
await handler({ type: "message_end", message: { role: "assistant", content: "answer" } }, mockCtx);
```

### Testing stateful extensions

For extensions with module-level state, **test lifecycle sequences** end-to-end:

```typescript
it("full lifecycle", async () => {
  const mockPi = createMockPi();
  const mockCtx = createMockCommandContext();
  await myExtension(mockPi);

  const handler = mockPi.registerCommand.mock.calls[0][1].handler;
  const sessionStart = getEventHandler(mockPi, "session_start");

  // Start
  await handler("start task", mockCtx);
  expect(mockPi.appendEntry).toHaveBeenCalledWith("my-state", expect.any(Object));

  // Simulate session reload
  mockPi.appendEntry.mockClear();
  await sessionStart({ type: "session_start", reason: "new" }, mockCtx);

  // Assert reconstructed state
  expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("my-key", expect.stringContaining("active"));
});
```

---

## Testing workflow

The preferred way to test extensions as you code them:

```bash
# In one terminal: run pi with the extension
pi -e extensions/<name>/<name>.ts

# In another terminal: edit the file
# Use /reload inside pi to hot-reload changes
```

For automated validation before committing:

```bash
npm run validate          # Validate all extensions
npm run test              # Run all tests
npm run check             # Format, lint, typecheck, validate, and test
npm run check:ci          # CI-friendly check (no --write, includes tests)
```

---

## Pi API reference

### Register a tool (callable by the LLM)

```typescript
pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does (shown to LLM)",
  parameters: {
    type: "object",
    properties: {
      input: { type: "string", description: "The input to process" },
    },
    required: ["input"],
  },
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    return {
      content: [{ type: "text", text: `Processed: ${params.input}` }],
      details: {},
    };
  },
});
```

### Register a slash command (user-triggered via `/command`)

```typescript
pi.registerCommand("myCommand", {
  description: "What this command does",
  handler: async (args, ctx) => {
    ctx.ui.notify("Hello!", "info");
  },
});
```

### Register a message renderer (hides or styles custom messages)

```typescript
pi.registerMessageRenderer("my-type", () => undefined);
```

Returning `undefined` hides the message from the conversation UI entirely.

### Hook lifecycle events

```typescript
pi.on("session_start", async (event, ctx) => {
  // Reconstruct state, clear stale data
});

pi.on("message_end", async (event, ctx) => {
  // Capture assistant responses
});

pi.on("input", async (event, ctx) => {
  // React to new user input
});

pi.on("before_agent_start", async (event, ctx) => {
  // Inject system prompt modifications
});
```

### Direct LLM call (bypasses conversation tree)

```typescript
import { complete } from "@earendil-works/pi-ai";

const response = await complete(
  ctx.model,
  { systemPrompt: "...", messages: [{ role: "user", content: [{ type: "text", text: "..." }] }] },
  { apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal },
);
```

Use this for side questions or one-off queries that should not appear in the main conversation.

### Modal UI with `ui.custom`

```typescript
const result = await ctx.ui.custom<string>((_tui, theme, _keybindings, done) => {
  // Start async work
  doWork().then(done).catch((err) => done(`Error: ${err.message}`));

  return {
    render: (width) => ["Loading..."],
    invalidate: () => {},
    handleInput: (data) => {
      if (data === "\r") done(undefined); // Enter key
    },
  };
});
```

The factory receives `(tui, theme, keybindings, done)` and must return a component with `render(width)` and optionally `handleInput(data)` and `invalidate()`.

---

## Validation

Validation logic lives in `lib/validate-extension.ts`. CLI entry points are in `scripts/`:

```bash
npm run validate          # Validate all extensions (no subprocesses)
npm run validate:one <path>  # Validate a single extension
```

Checks run on every extension:
- Valid TypeScript syntax
- Required default export (async function)
- No undeclared npm imports
- At least one pi API call (`registerTool`, `registerCommand`, `on`, or `appendEntry`)

---

## Project structure

```
pi-extensions/
├── extensions/         # Extension files
│   ├── <name>/
│   │   ├── <name>.ts   # Root entrypoint (default export)
│   │   └── src/        # Implementation modules (omit for trivial single-purpose extensions like clear)
│   └── ...
├── lib/                # Shared validation logic
├── scripts/            # CLI entry points
├── test/
│   ├── extensions/     # Per-extension tests
│   ├── mocks/          # Shared test mock factories
│   └── validator.test.ts
├── types/              # Ambient type declarations for "pi"
└── AGENTS.md           # This file
```

### Shared mock factories

- `createMockPi()` — mock `ExtensionAPI`
- `createMockContext()` — mock `ExtensionContext`
- `createMockCommandContext()` — mock `ExtensionCommandContext`
- `createMockUI()` — mock `ExtensionUIContext`

All return `vi.fn()` for every method. Override inline for test-specific behavior.
