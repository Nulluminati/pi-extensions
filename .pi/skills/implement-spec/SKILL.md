---
name: implement-spec
description: Implement a Pi extension from a product-design specification document. Reads a spec from docs/specs/, designs and builds an extension that fulfills the product intent (user stories, flows, capabilities, lifecycle, edge cases, rationale), and creates the extension file, tests, type declarations, and README entry following all repo conventions. Produces a fully validated, tested extension ready to commit.
---

# Implement Spec: Build an Extension from a Product Specification

Design and implement a Pi extension from a **product-design specification**, producing a complete, validated extension that follows all repo conventions in `AGENTS.md`.

## Core Principle

**The spec is a product design target, not a blueprint.** A product spec captures *what* the extension should do and *why* — the problem, the user stories, the flows, the lifecycle, the feedback, the edge cases, and the rationale behind the design. It deliberately does **not** prescribe implementation: it has no code, no type names, no exact strings, no literal constants, no field layouts, and none of the extension's own function or variable names. That is the point.

One thing the spec *does* name, as a contract rather than a suggestion: the Pi platform APIs the behavior leans on (the *Pi API Usage & Flow* section). Those names — `registerTool`, `appendEntry`, `on("session_start")`, `ui.custom`, `complete`, and the rest — are the platform's vocabulary, not the original author's. Use them; the behavior you're rebuilding depends on the same hooks. Everything *beneath* that surface — your types, your function names, your constants, your messages, your file structure — is yours to invent.

So your job is to **invent the implementation**. Design the types, choose the function names, pick the constants, write the exact user-facing messages, decide the internal structure — all in service of the experience and intent the spec describes. Read the spec as a product person would: understand the problem it solves and the experience it promises, then engineer the best extension you can that delivers it.

Two obligations follow from this:

1. **Deliver the product.** Every user story, capability, flow, lifecycle state, feedback cue, and edge case in the spec should be reflected in observable behavior. A user following the spec's flows should be able to complete each one and perceive the described feedback. Non-goals and design rationale are binding too: respect the trade-offs the spec makes, and don't add scope it deliberately excludes.
2. **Make good engineering choices.** The spec paraphrases messages and gives only rough magnitudes for limits. You produce concrete wording and real values. Match the *intent and tone* the spec describes — if it says "a short confirmation naming the objective," write exactly that kind of message. Where it says "capped at a few thousand characters," pick a sensible concrete limit. The wording and the numbers are yours to choose; the experience is the spec's to define.

If the spec is ambiguous or leaves a gap, pick the simplest interpretation that still honors the stated intent and rationale, and add a brief code comment noting the decision.

## When to Use

- When you have a product-design specification in `docs/specs/` and need to implement it as a working extension
- When another agent or developer produced a spec and handed it off for implementation
- When building an extension from a forward-looking spec (one written before any source existed)

## Procedure

### 1. Read the specification

Use `read` to load the full spec from `docs/specs/<name>.md`. Read it completely before writing any code. Sit with the problem section and the concept until you can describe in your own words what this product is and who it's for.

Also read these reference files (they define the conventions you must follow):

- `AGENTS.md` — code conventions, naming, state management, testing rules
- `types/pi.d.ts` — existing type declarations; you must update this if the extension needs APIs not yet declared
- `test/mocks/context-mocks.ts` — mock factory shapes for testing
- `test/mocks/test-helpers.ts` — shared test helpers (`getEventHandler`, `getCommandHandler`)
- Existing extensions (e.g. `extensions/goal/goal.ts`) — for Pi API usage patterns. Read them for *how* to call the API, not to copy structure or wording.

### 2. Design before you code

Sketch the implementation against the spec before writing the file. Work out:

- **The product surface**: which slash commands, tools, event handlers, and message renderers the capabilities and flows imply. The spec won't name them; you decide names that match AGENTS.md conventions and read well.
- **The state model**: what observable states the lifecycle describes, and how you'll represent them internally. Map the spec's user-visible states to an internal representation, but remember the internal layout is yours to design.
- **The feedback**: for each notification, status indicator, confirmation, and modal the spec describes, decide the concrete message, tone, and trigger.
- **The limits**: turn the spec's "roughly a few thousand characters" into a concrete, reasonable constant, guided by the rationale given.
- **The edge cases**: plan how each failure mode in the spec is handled (reload, cancel, budget hit, conflicting actions).

Designing first keeps the implementation coherent and prevents drift mid-build.

### 3. Create the extension file

Create `extensions/<name>/<name>.ts` following the exact file structure from `AGENTS.md`:

```
1. JSDoc header (name + short description)
2. Imports (external runtime modules, then `import type` from "pi", then relative imports)
3. Constants (UPPER_SNAKE_CASE)
4. Types (PascalCase)
5. Pure utility functions (camelCase)
6. Default export (async function)
```

**Implementation order within the default export:**

1. State variables (closure-scoped, not module-level if possible)
2. Helper functions that close over state
3. Event handlers (`pi.on(...)`)
4. Tools (`pi.registerTool(...)`)
5. Commands (`pi.registerCommand(...)`)
6. Message renderers (`pi.registerMessageRenderer(...)`)

Choose identifiers that follow AGENTS.md naming conventions and read clearly. You're naming your own code; don't go looking for "the right name" elsewhere, because the spec deliberately didn't supply any.

### 4. Update type declarations

If the extension uses runtime APIs not in `types/pi.d.ts`, add minimal declarations:

```typescript
declare module "@earendil-works/pi-ai" {
  export function complete(model: any, payload: any, options: any): Promise<any>;
}
```

Keep declarations loose (`any` for complex nested types). The goal is TypeScript compilation, not perfect typing.

### 5. Create the test file

Create `test/extensions/<name>.test.ts` following the patterns from `AGENTS.md` and the `write-tests` skill. Test the **behavior the spec describes**, not code you invented: each test should map back to a user story, a flow, a lifecycle transition, a feedback cue, or an edge case from the spec.

Coverage should include:

1. **Registration** — every `registerCommand`, `registerTool`, `registerMessageRenderer`, and `pi.on` call your implementation makes
2. **Command handler branches** — every path the flows exercise, including validation errors and the success path
3. **Tool execution** — every behavior a tool provides, asserting it does what the capability requires
4. **Event handlers** — every registered event handler and what it does
5. **State lifecycle** — if stateful: the start → transition → end sequences the lifecycle section describes
6. **Error paths** — every failure mode the spec's edge cases call out
7. **Session reconstruction** — if the spec says the extension survives reloads, test that `session_start` restores state from `sessionManager.getBranch()`

Use the repo's mock factories:

```typescript
import { createMockPi } from "../mocks/pi-mocks.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { getEventHandler, getCommandHandler } from "../mocks/test-helpers.ts";
```

### 6. Update the README

Add a row to the Extensions table in `README.md`:

```markdown
| `<name>/` | <One-line description capturing the spec's Concept section> |
```

If the extension has flags or configuration, add a subsection under "Extension configuration" following the existing pattern (see `session-recap` flags in the README for reference).

### 7. Validate and fix

Run the full check pipeline. Fix every error before proceeding:

```bash
npm run validate:one extensions/<name>/<name>.ts   # Must pass
npm run test                                         # Must pass
npm run check                                        # Must pass (format + lint + typecheck + validate + test)
```

Common fixes:

- **Biome formatting**: Run `npm run format` or `biome check --write .` to fix import ordering and formatting
- **TypeScript errors**: Check `types/pi.d.ts` — missing type declarations are the most common cause
- **Validation failures**: Missing default export, undeclared npm imports, no pi API calls
- **Test failures**: Mock shapes don't match, missing `vi.fn()` wrappers, test isolation issues

### 8. Final review

After all checks pass, review the implementation against the spec as a **product**: does it actually deliver the experience the spec promises? Walk the spec's user flows yourself, mentally, and confirm each one works end to end with the described feedback.

- [ ] **Problem & Motivation (§1)**: the implementation genuinely addresses the stated problem
- [ ] **Concept (§2)**: the central idea comes through in behavior, not just naming
- [ ] **User Stories (§3)**: every story is satisfiable by the extension
- [ ] **Capabilities (§4)**: all user, agent, and background capabilities are implemented
- [ ] **User Flows (§5)**: each flow can be completed, with the described observable steps
- [ ] **Lifecycle & States (§6)**: every state exists, every transition fires on the described trigger, and the right thing is visible in each state
- [ ] **Feedback & Visibility (§7)**: each notification, status, confirmation, and modal appears at the right moment with the right tone — in your own wording, matching the described intent
- [ ] **Agent Influence (§8)**: tools the agent gains, system-prompt steering, and loop control all behave as described
- [ ] **Pi API Usage & Flow (§9)**: the implementation relies on the same Pi platform APIs the spec names (registration, lifecycle hooks, state, UI, direct model calls) and follows the described flow — the platform contract is honored even though the internal code structure is your own
- [ ] **Constraints & Limits (§10)**: each guard-rail is present, with concrete values justified by the spec's rationale
- [ ] **Edge Cases & Failure Modes (§11)**: every listed scenario is handled gracefully
- [ ] **Design Rationale (§12)**: the implementation honors the trade-offs and decisions the spec explains
- [ ] **Non-Goals (§13)**: nothing from the non-goals list has crept in
- [ ] `types/pi.d.ts` is updated if needed
- [ ] README has the new extension entry
- [ ] `npm run check` passes clean

## Rules

### MUST

1. **Read the full spec before writing any code.** Understand the problem, concept, and intent first. The whole point is to deliver the described experience — you can't deliver what you haven't absorbed.
2. **Design the implementation yourself.** You choose the types, names, constants, strings, and structure. They aren't given to you; invent them well, following AGENTS.md conventions.
3. **Deliver the product described in the spec.** Every user story, capability, flow, lifecycle state, feedback cue, and edge case should be reflected in observable behavior. A reader of the spec should recognize the implementation.
4. **Honor the intent and tone of the described feedback.** The spec paraphrases ("a short confirmation naming the objective"). Write concrete wording that matches that intent and tone. The exact words are yours; the experience they create is the spec's.
5. **Pick concrete limits justified by the spec's rationale.** Where the spec says "roughly a few thousand characters," choose a sensible value and let the stated reason ("to keep the prompt lean") guide the choice.
6. **Respect design rationale and non-goals (§12, §13).** These are binding. If the spec says auto-continuation is opt-in to preserve trust, don't make it always-on. If a non-goal says "no concurrent goals," don't add them.
7. **Follow AGENTS.md code conventions exactly.** File structure order, naming conventions, import ordering, error handling patterns, state management strategy.
8. **Write tests for every behavior the spec describes.** Each test should trace back to a user story, flow, lifecycle transition, feedback cue, or edge case.
9. **Use the repo's mock factories.** `createMockPi()`, `createMockCommandContext()`, `getEventHandler()`, `getCommandHandler()`. Never build your own mocks from scratch.
10. **Use `vi.resetAllMocks()` in `beforeEach`.** Not `clearAllMocks()`. This prevents stale implementations from bleeding between tests.
11. **Wrap all mock overrides in `vi.fn()`.** Typed mocks require `Mock` instances, not plain functions:
    ```typescript
    // BAD
    mockCtx.getContextUsage = () => ({ tokens: 5000, contextWindow: 200_000, percent: 2.5 });
    // GOOD
    mockCtx.getContextUsage = vi.fn(() => ({ tokens: 5000, contextWindow: 200_000, percent: 2.5 }));
    ```
12. **Mock external runtime modules** (`@earendil-works/pi-ai`, `@earendil-works/pi-tui`) with `vi.mock()` at the top of the test file. If `@earendil-works/pi-tui` is used, it's already mocked globally via `test/setup/pi-tui.ts`.
13. **Never use non-null assertions (`!`).** Use proper null checks or pass validated values as parameters.
14. **Never add external npm dependencies.** Pi transpiles extensions directly. Only allowed imports are: `pi`, `typebox`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, and Node.js built-ins.
15. **Update `types/pi.d.ts`** when using runtime APIs not in the stubs.
16. **Run `npm run check`** and ensure it passes clean before finishing.
17. **Isolate environment variables with `vi.stubEnv`** in tests. Never assign to `process.env` directly.
18. **Use `vi.useFakeTimers()`** when testing timer-based behavior. Never depend on real time.
19. **Use `vi.fn()` for nested mock overrides** like `sessionManager.getBranch`:
    ```typescript
    mockCtx.sessionManager.getBranch = vi.fn(() => [
      { type: "custom", customType: "my-state", data: { ... } },
    ]);
    ```
20. **Test state reconstruction** for persistent extensions. Mock `sessionManager.getBranch()`, fire `session_start`, and assert state is restored correctly.
21. **Clear mocks between lifecycle phases** in multi-step tests. Use `mockClear()` to prevent assertions from passing due to earlier phases.

### MUST NOT

1. **Do NOT add features outside the spec.** Honor the non-goals. If you think of a nice-to-have, note it in a comment but don't implement it. The spec describes a specific product; build that product.
2. **Do NOT skip edge cases the spec documents (§11).** Those failure modes are part of the contract. Implement all of them.
3. **Do NOT go hunting for exact strings to copy.** The spec has none — it paraphrases on purpose. Don't search other extensions' source for "the message." Write your own wording that matches the described intent and tone.
4. **Do NOT copy code from other extensions.** Read them for Pi API patterns (how to call `registerTool`, how `ui.custom` works), then implement fresh. Copying structure, types, helpers, or strings defeats the purpose and produces clones instead of a considered implementation.
5. **Do NOT ignore the design rationale (§12).** If the spec explains *why* something is shaped a certain way, that reasoning is a constraint on your implementation. Don't quietly contradict it with a "simpler" approach that abandons the trade-off.
6. **Do NOT use module-level `let` for state when closure scope works.** Module-level variables leak across Pi instances and test runs. If state is needed, use closure-scoped variables inside the default export function, or the appropriate state strategy from AGENTS.md.
7. **Do NOT swallow errors silently.** Every error path must either notify the user (`ctx.ui.notify`) or propagate to the caller.
8. **Do NOT skip the README update.** Every extension must be listed in the Extensions table.
9. **Do NOT leave placeholder code (TODO, FIXME, stub functions).** The implementation must be complete and functional.
10. **Do NOT commit without running `npm run check`.** Format, lint, typecheck, validate, and test must all pass.
11. **Do NOT use `any` where proper types are available.** Use `import type` from `"pi"` for all Pi API types. `any` is only acceptable in `types/pi.d.ts` ambient declarations for complex runtime types.
12. **Do NOT forget to mock `ctx.getContextUsage()`** when the extension tracks tokens. A missing mock causes `NaN` or `undefined` token usage.
13. **Do NOT write tests that depend on real time.** Use `vi.useFakeTimers()` for any timer-based behavior. Real-time tests are flaky.
14. **Do NOT reuse mock instances across tests.** Create fresh `createMockPi()` and `createMockCommandContext()` in each test.

## Implementation Checklist

Use this checklist while implementing. Check off each item as you complete it:

### File Creation
- [ ] `extensions/<name>/<name>.ts` created
- [ ] `test/extensions/<name>.test.ts` created
- [ ] `types/pi.d.ts` updated (if needed)
- [ ] `README.md` updated with new extension entry

### Extension Structure (from AGENTS.md)
- [ ] JSDoc header with name and description
- [ ] Imports in correct order (external runtime → `import type` from "pi" → relative)
- [ ] Constants in UPPER_SNAKE_CASE
- [ ] Types in PascalCase
- [ ] Pure utility functions before default export
- [ ] Default export is an async function

### Spec Delivery
- [ ] Problem & Motivation (§1) is addressed by the implementation
- [ ] Concept (§2) is evident in behavior
- [ ] All User Stories (§3) are satisfiable
- [ ] All Capabilities (§4) implemented — user, agent, and background
- [ ] All User Flows (§5) completable end to end
- [ ] Lifecycle & States (§6) — every state and transition implemented
- [ ] Feedback & Visibility (§7) — notifications, status, confirmations, modals in place with matching intent and tone
- [ ] Agent Influence (§8) — tools, prompt steering, loop control all implemented
- [ ] Pi API Usage & Flow (§9) — same Pi platform APIs relied on, described flow followed; internal structure still your own
- [ ] Constraints & Limits (§10) — each guard-rail present with a concrete, justified value
- [ ] Edge Cases & Failure Modes (§11) — all handled
- [ ] Design Rationale (§12) — trade-offs honored
- [ ] Non-Goals (§13) — no out-of-scope features added

### Testing
- [ ] Registration tests for all APIs
- [ ] Command handler tests for every flow path
- [ ] Tool execution tests for each capability
- [ ] Event handler tests
- [ ] State lifecycle tests (if stateful)
- [ ] Error path tests for each edge case
- [ ] Session reconstruction tests (if persistent)
- [ ] `vi.resetAllMocks()` in `beforeEach`
- [ ] `vi.fn()` on all mock overrides
- [ ] Environment variables isolated with `vi.stubEnv` (if needed)
- [ ] Fake timers for timer-based tests (if needed)

### Validation
- [ ] `npm run validate:one extensions/<name>/<name>.ts` passes
- [ ] `npm run test` passes
- [ ] `npm run check` passes (format + lint + typecheck + validate + test)

## Common Patterns

These are Pi API and testing references, not spec content. Use them to learn *how* to call the runtime and *how* to test in this repo; adapt them to deliver the product your spec describes. They are not templates to copy verbatim.

### Stateful extension with persistence

```typescript
export default async function myExtension(pi: ExtensionAPI) {
  let state: MyState | null = null;

  function persistState() {
    pi.appendEntry("my-state", { state });
  }

  pi.on("session_start", async (_event, ctx) => {
    state = reconstructState(ctx);
    if (state) updateStatusLine(ctx);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    if (state) persistState();
  });

  // ... tools, commands, event handlers
}

function reconstructState(ctx: ExtensionContext): MyState | null {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "custom" && entry.customType === "my-state") {
      const data = entry.data as { state?: MyState | null } | null;
      return isMyState(data?.state) ? data.state : null;
    }
  }
  return null;
}
```

### State validation guard

```typescript
function isMyState(value: unknown): value is MyState {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<MyState>;
  return (
    typeof s.id === "string" &&
    typeof s.status === "string" &&
    ["active", "paused", "complete"].includes(s.status)
    // ... all required fields
  );
}
```

### Tool with prompt guidelines

```typescript
pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does (shown to LLM)",
  promptSnippet: "Short snippet for autocomplete",
  promptGuidelines: [
    "Guideline 1 for LLM behavior",
    "Guideline 2 for LLM behavior",
  ],
  parameters: {
    type: "object",
    properties: {
      input: { type: "string", description: "The input to process" },
    },
    required: ["input"],
  },
  execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
    if (! precondition) {
      return {
        content: [{ type: "text", text: "your own error wording here" }],
        details: { error: "error_code" },
        terminate: true,
      };
    }
    return {
      content: [{ type: "text", text: "your own success wording here" }],
      details: { status: "success" },
      terminate: false,
    };
  },
});
```

### Modal UI with async work

```typescript
const result = await ctx.ui.custom<string>((_tui, theme, _keybindings, done) => {
  doAsyncWork()
    .then((value) => done(value))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      done(`Error: ${message}`);
    });

  return {
    render: (width: number) => ["Loading..."],
    invalidate: () => {},
    handleInput: (data: string) => {
      if (data === "\r" || data === "\x1b") done(undefined);
    },
  };
});
```

### Testing ui.custom

```typescript
mockCtx.ui.custom = vi.fn((factory: any) => {
  return new Promise((resolve) => {
    const done = resolve;
    const theme = {
      fg: (_c: string, text: string) => text,
      bold: (text: string) => text,
      dim: (text: string) => text,
      italic: (text: string) => text,
      underline: (text: string) => text,
      strike: (text: string) => text,
    };
    const component = factory(null, theme, null, done);
    // Auto-resolve modal dialogs so tests don't hang
    if (component.handleInput) {
      setTimeout(() => done(undefined), 0);
    }
  });
});
```

### Testing with fake timers

```typescript
it("auto-dismisses status after timeout", async () => {
  vi.useFakeTimers();
  try {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    // ... set up extension and trigger completion ...
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("my-ext", "✅ complete");
    vi.advanceTimersByTime(8000);
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("my-ext", undefined);
  } finally {
    vi.useRealTimers();
  }
});
```

### Testing environment variables

```typescript
beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("MY_API_KEY", "test-key");
});

it("errors when API key is missing", async () => {
  vi.stubEnv("MY_API_KEY", "");
  // ... test that error is shown
});
```
