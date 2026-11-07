---
name: write-tests
description: Write robust, maintainable tests for Pi extensions. Use when creating, reviewing, or fixing tests for extension tools, commands, event handlers, and stateful lifecycle behavior.
---

# Writing Tests for Pi Extensions

This skill provides concrete rules for writing tests that catch real bugs in Pi extensions — especially stateful extensions with event handlers, tools, and commands.

## Setup

Tests live in `test/extensions/<name>.test.ts` and import the extension via relative path. The repo uses Vitest with `createMockPi()` and `createMockCommandContext()` from `test/mocks/`.

Choose the test style by what the behavior depends on:

- **Mock tests** (`test/extensions/`, default suite): call handlers, tools and commands directly with typed mocks. Use them for branches, error paths, UI calls and anything that needs fake timers.
- **Session tests** (`test/runtime/`, runtime suite): run the extension in a real Pi session with `createPiSession` from `test/harness/pi-session.ts`. Use them for lifecycle behavior that depends on how Pi wires events, tools and session entries together. Assert on session messages and entries, not on mock calls.

## MUST

1. **Test the full tool result shape.** Every field the Pi runtime inspects must be asserted:
   - `result.content` — what the model sees
   - `result.details` — structured data for logs / rendering
   - `result.terminate` — when the tool should end the turn (`true` for completion, error, or abort tools)
   ```typescript
   expect(result.content[0].text).toBe("Added 1 item(s):\n1. ☐ first");
   expect(result.details).toEqual({ items: [{ text: "first", completed: false }] });
   ```

2. **Test every event handler registered by the extension.** Call `pi.on(...)` handlers directly and assert their behavior:
   ```typescript
   const agentEndHandler = getEventHandler(mockPi, "agent_end");
   await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);
   ```

3. **Write lifecycle tests for stateful extensions.** State leaks across missions, sessions, and turns. Test full sequences:
   ```typescript
   // BAD: tests each handler in isolation
   // GOOD: test the lifecycle
   await tool.execute("call-1", { action: "create", title: "Migration" }, undefined, undefined, mockCtx);
   await tool.execute("call-2", { action: "task_update", taskId: "t1", status: "done" }, undefined, undefined, mockCtx);
   await handler({ type: "session_start", reason: "resume" }, mockCtx);
   expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("missions", expect.stringContaining("active"));
   ```

4. **Clear mocks between lifecycle phases.** Use `mockClear()` so assertions don't pass accidentally from earlier phases:
   ```typescript
   mockPi.sendUserMessage.mockClear();
   mockCtx.ui.setStatus.mockClear();
   ```

5. **Assert state is persisted via `pi.appendEntry`.** Any extension that calls `appendEntry` for durability must have tests verifying the entry data shape:
   ```typescript
   expect(mockPi.appendEntry).toHaveBeenCalledWith(
     "missions-active",
     expect.objectContaining({ id: expect.any(String) }),
   );
   ```

6. **Assert on UI calls for user-facing state.** Status lines, notifications, and confirmations must be tested:
   ```typescript
   expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("missions", expect.stringContaining("active"));
   expect(mockCtx.ui.notify).toHaveBeenCalledWith("No active mission to reconcile.", "info");
   ```

7. **Test error paths with the same rigor as success paths.** Call tools when preconditions fail, assert the error content, details, and `terminate` flag.

8. **Use `toHaveBeenNthCalledWith` for ordered assertions.** When multiple calls happen to the same mock, assert order matters:
   ```typescript
   expect(mockCtx.ui.setStatus).toHaveBeenNthCalledWith(1, "missions", undefined); // clear first
   expect(mockCtx.ui.setStatus).toHaveBeenNthCalledWith(2, "missions", expect.stringContaining("active"));
   ```

9. **Test state reconstruction from `sessionManager.getBranch`.** Stateful extensions must be testable for session restore:
   ```typescript
   mockCtx.sessionManager.getBranch = () => [{
     type: "custom", customType: "missions-active",
     data: { id: "m1" },
   }];
   // fire session_start, assert reconstructed behavior
   ```

10. **Cover all branches in `if/else` and `switch` handlers.** Tools and commands with conditional logic need tests for each branch (budget exceeded, task already done, no active mission, etc.).

11. **Test timer and async cleanup.** If an extension uses `setTimeout` or `setInterval`, add lifecycle tests that verify the timer is cleared on state transitions (start, resume, clear, shutdown).

12. **Verify that state from mission A does not contaminate mission B.** After completing or clearing one mission, start another and assert that old flags, counters, or timers are reset.

13. **Use `vi.resetAllMocks()` in `beforeEach`, not `vi.clearAllMocks()`.** `clearAllMocks` only clears call counts; `resetAllMocks` also resets mock implementations, preventing stale return values from bleeding between tests:
    ```typescript
    beforeEach(() => {
      vi.resetAllMocks();
    });
    ```

14. **Isolate environment variables with `vi.stubEnv`.** Never assign to `process.env` directly in tests. The real environment can leak values and `delete process.env.X` does not restore the original value:
    ```typescript
    beforeEach(() => {
      vi.resetAllMocks();
      vi.unstubAllEnvs();
      vi.stubEnv("BRAVE_API_KEY", "test-key");
    });
    ```
    In tests that need the variable absent, override with an empty string (which is falsy):
    ```typescript
    vi.stubEnv("BRAVE_API_KEY", "");
    ```

15. **Register process-global cleanup in `afterEach` with a module-level array.** When monkey-patching `process.stdin`, `process.stdout`, or other globals, collect restore functions in an array and drain it in `afterEach`. The `afterEach` hook runs even if a test throws, guaranteeing cleanup:
    ```typescript
    const globalRestores: Array<() => void> = [];

    afterEach(() => {
      for (const restore of globalRestores) restore();
      globalRestores.length = 0;
    });

    function mockTTY() {
      const originalStdin = process.stdin;
      // ... override process.stdin ...
      let restored = false;
      const restore = () => {
        if (restored) return;
        restored = true;
        Object.defineProperty(process, "stdin", { value: originalStdin, writable: true, configurable: true });
      };
      globalRestores.push(restore);
      return { /* ... */ };
    }
    ```

## MUST NOT

1. **Do NOT assert only `toHaveBeenCalled` without checking arguments.** `toHaveBeenCalled()` tells you the mock was hit but not with what data. Always use `toHaveBeenCalledWith` or `toHaveBeenNthCalledWith`.

2. **Do NOT create a fresh mockPi/mockCtx per sub-step inside one test.** Create them once at test start. Reusing the same extension instance across the test validates real state behavior.

3. **Do NOT skip testing event handlers because they are "just plumbing."** The `agent_end` → `maybeQueueContinuation` → `sendUserMessage` path is where most continuation bugs live.

4. **Do NOT test only the happy path.** Every tool that checks `if (!state || state.status !== "active")` needs a test for the negative branch.

5. **Do NOT use deep equality checks on mock call history.** `expect(mockFn.mock.calls).toEqual([...])` is brittle. Prefer `toHaveBeenCalledWith` assertions.

6. **Do NOT forget to mock `ctx.getContextUsage()` when testing token-tracking extensions.** A missing mock here causes `NaN` or `undefined` token usage.

7. **Do NOT write tests that depend on real time.** Use `vi.useFakeTimers()` when testing timer-based behavior. Otherwise tests become flaky.

8. **Do NOT ignore the `before_agent_start` / `turn_end` / `message_end` handlers.** These are often where budget checks, pause-on-error, and system-prompt injection happen.

9. **Do NOT test the extension factory in isolation from the extension instance.** Calling `await missionsExtension(mockPi)` wires up handlers and closure state. Tests that skip this step miss real behavior.

10. **Do NOT leave commented-out or `.only` tests in the committed suite.** Run the full suite before committing.

11. **Do NOT duplicate `vi.mock` factories across test files.** If multiple test suites mock the same runtime module (e.g., `@earendil-works/pi-tui`), extract the mock to `test/setup/<module>.ts` and add it to `setupFiles` in `vitest.config.ts`:
    ```typescript
    // vitest.config.ts
    test: {
      setupFiles: ["./test/setup/pi-tui.ts"],
    }
    ```
    ```typescript
    // test/setup/pi-tui.ts
    import { vi } from "vitest";
    vi.mock("@earendil-works/pi-tui", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@earendil-works/pi-tui")>()),
      isKittyProtocolActive: vi.fn(() => false),
    }));
    ```

12. **Do NOT stub a Pi export that runs in a unit test.** The setup files spread the real module and stub only exports that need a live TUI, the global theme, process-wide terminal state, or the real `~/.pi`. Write the reason next to each stub. A stub that renders or behaves differently from Pi hides bugs: the old `Input` stub hid a cursor bug in prefilled fields. Test the real components in `test/runtime/` when a unit test cannot run them.

## Best Practices

### Mock Factory Pattern

Use the repo's `createMockPi()` and `createMockCommandContext()` factories, and annotate variables with their types `MockPi`, `MockContext` and `MockCommandContext`. They are typed as `DeepMocked<T>` of the real SDK types, and every mocked function is `Mock<T>` of the real signature. So a member that Pi adds, renames or removes, a wrong argument, a wrong return value and a replacement `vi.fn` with the wrong shape all fail `tsc -p tsconfig.test.json`. `test/mocks/mock-types.test.ts` proves this with `@ts-expect-error` lines. Keep the mocks complete; do not cast a mock to silence an error.

Two kinds of SDK function cannot be checked against one implementation:

- Overloaded or generic methods (`pi.on`, `pi.registerTool`, `ui.custom`, `ui.setWidget`): assign `mockFn()` from `test/mocks/mock-types.ts`. Calls and `.mock` keep the real type; the implementation is not checked.
- Recorded `pi.on` and `pi.registerTool` calls: `MockPi` reads them back as (event name, handler for any event) and as a tool of any schema. Use `getEventHandler` and `getCommandHandler` from `test/mocks/test-helpers.ts`.

For deliberate partial fakes, use the helpers in `test/mocks/test-helpers.ts`. Each one is the single documented place where a fixture is asserted as the SDK type: `fakeTui()`, `fakeTheme({...})`, `fakeKeybindings()`, `sessionEntries([...])` for `getBranch` and `getEntries`, and `fixtureAs({...})` for other partial SDK objects. Read tool results with `contentText(result)`. For a partial return value on a single function, `vi.mocked(fn, { partial: true })` is also fine.

`Theme` and `ModelRegistry` are classes with private fields. Their mocks go through `asSdkMock` in `test/mocks/mock-types.ts`, which checks the public members and then asserts the class type, so a mock context still passes where the SDK context type is expected.

Use `createMockModel(overrides)` from `test/mocks/context-mocks.ts` for a complete `Model`, and `fauxAssistantMessage(...)` from `@earendil-works/pi-ai` for a complete model reply. Use `firstContentText(message)` from `test/mocks/test-helpers.ts` to read prompt text from a recorded model call.

If you need to override a mock mid-test, use `vi.fn()` so the assignment stays type-compatible:

```typescript
// With typed mocks, plain functions do not satisfy Mock-typed properties
// BAD: mockCtx.getContextUsage = () => ({ tokens: 5000, contextWindow: 200_000, percent: 2.5 });
// GOOD:
mockCtx.getContextUsage = vi.fn(() => ({ tokens: 5000, contextWindow: 200_000, percent: 2.5 }));
```

When overriding nested mock methods (e.g., `sessionManager.getBranch`), always wrap the return value in `vi.fn()`:
```typescript
mockCtx.sessionManager.getBranch = vi.fn(() => [
  { type: "message", message: { role: "user", content: "hello" } },
]);
```

### Typed Mocks and `noUncheckedIndexedAccess`

The repo's `tsconfig.json` enables `noUncheckedIndexedAccess: true`, which flags `mock.calls[0]` as possibly `undefined`. Test files use `tsconfig.test.json` which relaxes this flag because mock call arrays always contain data when tests access them. If you see `TS2532: Object is possibly 'undefined'` errors in test files, the test config is handling it automatically.

### Session Harness

`createPiSession` builds a real `AgentSession` with an in-memory session manager and settings, the given extension factories, and the pi-ai faux provider as the model. Script the model with `responses`; each request's context is recorded in `requests`. All Pi state lives in a temporary directory, so the harness never touches `~/.pi`.

```typescript
const harness = await createPiSession({
  extensions: [todosExtension],
  responses: [
    fauxAssistantMessage(fauxToolCall("todo", { action: "list" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ],
});
await harness.session.prompt("what is left?");
expect(harness.session.messages.filter((m) => m.role === "toolResult")).toMatchObject([...]);
await harness.dispose(); // emits session_shutdown, then removes the temporary directory
```

Use `setup` to append persisted entries before `session_start`, and `shutdown()` to assert on cleanup before `dispose()`. The harness only works in the runtime suite: the default suite stubs `@earendil-works/pi-coding-agent`.

### Extracting Handlers

Use the `getEventHandler` helper pattern from `test/extensions/missions.test.ts`:

```typescript
function getEventHandler(mockPi: any, eventType: string) {
  const calls = mockPi.on.mock.calls;
  for (const call of calls) {
    if (call[0] === eventType) return call[1];
  }
  throw new Error(`Event handler for ${eventType} not found`);
}
```

### Testing Tool Execute

Tools take 5 arguments: `(toolCallId, params, signal, onUpdate, ctx)`. Pass `undefined` for optional args:

```typescript
const result = await toolDef.execute(
  "call-1",
  { summary: "Done" },
  undefined,
  undefined,
  mockCtx,
);
```

### Testing Commands

Commands receive `(args: string, ctx: ExtensionCommandContext)`. The `args` string is raw user input after the command name:

```typescript
const handler = mockPi.registerCommand.mock.calls[0][1].handler;
await handler("--tokens 100k fix the bug", mockCtx);
```

### State Machine Tests

For extensions with a state machine (active → paused → complete → budget), create a matrix test that walks every transition:

```typescript
const transitions = [
  { from: "active", action: "pause", expected: "paused" },
  { from: "paused", action: "resume", expected: "active" },
  { from: "active", action: "complete", expected: "complete" },
];
for (const { from, action, expected } of transitions) {
  // set up state, perform action, assert new status
}
```

### Budget / Limit Tests

When an extension tracks budgets (tokens, time, iterations), test the boundary:
- Exactly at the limit
- One unit over the limit
- With and without a limit configured

### Regression Tests

When you fix a bug, add a test that would have failed before the fix. Name it descriptively:
```typescript
it("check with no ids returns terminate: true so the turn ends immediately", ...);
```

### Biome Import Ordering

After modifying imports in test or mock files, run `biome check --write` (not just `biome format --write`) to apply the `organizeImports` assist action. The CI command `biome ci .` will fail if imports are out of order.
