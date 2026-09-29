import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sessionRecapExtension from "../../extensions/session-recap/session-recap.ts";
import { __resetWidgetStrip, STRIP_KEY_ABOVE } from "../../lib/widget-strip.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { getCommandHandler, getEventHandler } from "../mocks/test-helpers.ts";

vi.mock("@earendil-works/pi-ai", () => ({
  completeSimple: vi.fn(),
}));

// Helper to set up TTY mocks for focus reporting tests
const ttyRestores: Array<() => void> = [];

function mockTTY(): {
  stdoutWrite: ReturnType<typeof vi.fn>;
  stdinOn: ReturnType<typeof vi.fn>;
  stdinOff: ReturnType<typeof vi.fn>;
  capturedListener: ((chunk: Buffer) => void) | undefined;
  restore: () => void;
} {
  const originalStdin = process.stdin;
  const originalStdout = process.stdout;

  const stdoutWrite = vi.fn(() => true);
  let capturedListener: ((chunk: Buffer) => void) | undefined;

  const stdinOn = vi.fn((event: string, listener: unknown) => {
    if (event === "data") capturedListener = listener as (chunk: Buffer) => void;
    return process.stdin;
  });
  const stdinOff = vi.fn(() => process.stdin);

  Object.defineProperty(process, "stdin", {
    value: { isTTY: true, on: stdinOn, off: stdinOff },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(process, "stdout", {
    value: { isTTY: true, write: stdoutWrite },
    writable: true,
    configurable: true,
  });

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    Object.defineProperty(process, "stdin", {
      value: originalStdin,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process, "stdout", {
      value: originalStdout,
      writable: true,
      configurable: true,
    });
  };
  ttyRestores.push(restore);

  return {
    stdoutWrite,
    stdinOn,
    stdinOff,
    get capturedListener() {
      return capturedListener;
    },
    restore,
  };
}

// Helper to build a branch with meaningful assistant activity
function buildMeaningfulBranch(): unknown[] {
  return [
    {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "fix the auth bug" }],
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "I have analyzed the authentication flow and identified the root cause in the token validation middleware. The bug was that expired tokens were not being properly rejected. I updated the middleware to check the expiration timestamp before proceeding. I also added unit tests to verify the fix works correctly across all the edge cases, including expired tokens, malformed tokens, and tokens with invalid signatures. The test suite now passes completely with all green results.",
          },
        ],
      },
    },
  ];
}

describe("session-recap-extension", () => {
  beforeEach(() => {
    __resetWidgetStrip();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.resetAllMocks();
    vi.stubEnv("PI_SMALL_MODEL", "test-provider/test-model");
    vi.stubEnv("PI_SMALL_MODEL_THINKING", "minimal");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    for (const restore of ttyRestores) restore();
    ttyRestores.length = 0;
  });

  describe("file structure", () => {
    it("keeps one discoverable entrypoint and implementation modules under src", async () => {
      const extensionDir = resolve(import.meta.dirname, "../../extensions/session-recap");
      const rootEntries = await readdir(extensionDir, { withFileTypes: true });
      const rootTypeScriptFiles = rootEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => entry.name);
      const sourceFiles = await readdir(resolve(extensionDir, "src"));

      expect(rootTypeScriptFiles).toEqual(["session-recap.ts"]);
      expect(sourceFiles.filter((file) => file.endsWith(".ts"))).toHaveLength(8);
    });
  });

  it("registers all flags", async () => {
    const mockPi = createMockPi();
    await sessionRecapExtension(mockPi);
    expect(mockPi.registerFlag).toHaveBeenCalledWith(
      "recap-idle-seconds",
      expect.objectContaining({ type: "string", default: "45" }),
    );
    expect(mockPi.registerFlag).toHaveBeenCalledWith(
      "recap-focus-min-seconds",
      expect.objectContaining({ type: "string", default: "3" }),
    );
    expect(mockPi.registerFlag).toHaveBeenCalledWith(
      "recap-disable-focus",
      expect.objectContaining({ type: "boolean", default: false }),
    );
    expect(mockPi.registerFlag).toHaveBeenCalledWith(
      "recap-during-active",
      expect.objectContaining({ type: "boolean", default: false }),
    );
    expect(mockPi.registerFlag).toHaveBeenCalledWith(
      "recap-disable",
      expect.objectContaining({ type: "boolean", default: false }),
    );
    const flagNames = mockPi.registerFlag.mock.calls.map((call: unknown[]) => call[0]);
    expect(flagNames).not.toContain("recap-model");
  });

  it("registers /recap command", async () => {
    const mockPi = createMockPi();
    await sessionRecapExtension(mockPi);
    expect(mockPi.registerCommand).toHaveBeenCalledWith(
      "recap",
      expect.objectContaining({
        description: expect.stringContaining("recap"),
        handler: expect.any(Function),
      }),
    );
  });

  it("registers event handlers", async () => {
    const mockPi = createMockPi();
    await sessionRecapExtension(mockPi);
    expect(mockPi.on).toHaveBeenCalledWith("turn_end", expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith("turn_start", expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith("input", expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith("agent_start", expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith("agent_end", expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
  });

  it("session_start attaches focus reporting when TTY is available", async () => {
    const tty = mockTTY();
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await sessionRecapExtension(mockPi);

    const handler = getEventHandler(mockPi, "session_start");
    await handler({ type: "session_start", reason: "new" }, mockCtx);

    expect(tty.stdoutWrite).toHaveBeenCalledWith("\x1b[?1004h");
    expect(tty.stdinOn).toHaveBeenCalledWith("data", expect.any(Function));
  });

  it("session_start does not attach focus reporting when disabled", async () => {
    const tty = mockTTY();
    const mockPi = createMockPi();
    mockPi.getFlag = vi.fn((name: string) => {
      if (name === "recap-disable-focus") return true;
      return undefined;
    });
    const mockCtx = createMockCommandContext();
    await sessionRecapExtension(mockPi);

    const handler = getEventHandler(mockPi, "session_start");
    await handler({ type: "session_start", reason: "new" }, mockCtx);

    expect(tty.stdoutWrite).not.toHaveBeenCalled();
    expect(tty.stdinOn).not.toHaveBeenCalled();
  });

  it("session_start with resume triggers recap after delay", async () => {
    const { completeSimple } = await import("@earendil-works/pi-ai");
    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: "text", text: "recap: fixed the auth bug" }],
    });

    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(() => buildMeaningfulBranch());
    mockCtx.sessionManager.getLeafId = vi.fn(() => "leaf-1");
    await sessionRecapExtension(mockPi);

    const handler = getEventHandler(mockPi, "session_start");
    await handler({ type: "session_start", reason: "resume" }, mockCtx);

    // Should not call completeSimple immediately
    expect(completeSimple).not.toHaveBeenCalled();

    // Advance past the 300ms delay
    vi.advanceTimersByTime(400);
    await vi.waitFor(() => expect(completeSimple).toHaveBeenCalled());

    expect(mockCtx.ui.setWidget).toHaveBeenCalledWith(STRIP_KEY_ABOVE, expect.any(Function));

    // Verify the factory renders content with the recap text
    const factory = (mockCtx.ui.setWidget as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === STRIP_KEY_ABOVE && typeof c[1] === "function",
    )?.[1] as ((tui: unknown, theme: unknown) => unknown) | undefined;
    expect(factory).toBeDefined();
    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
    const component = factory!(null, theme) as { render: (w: number) => string[] };
    const lines = component.render(80);
    expect(lines.some((l: string) => l.includes("recap"))).toBe(true);
  });

  it("session_shutdown before the resume delay cancels the pending recap", async () => {
    const { completeSimple } = await import("@earendil-works/pi-ai");
    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: "text", text: "recap: fixed the auth bug" }],
    });

    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(() => buildMeaningfulBranch());
    mockCtx.sessionManager.getLeafId = vi.fn(() => "leaf-1");
    await sessionRecapExtension(mockPi);

    const startHandler = getEventHandler(mockPi, "session_start");
    await startHandler({ type: "session_start", reason: "resume" }, mockCtx);

    // Shutdown before the 300 ms resume delay elapses: the pending recap
    // must never fire on the stale context.
    const shutdownHandler = getEventHandler(mockPi, "session_shutdown");
    await shutdownHandler({ type: "session_shutdown", reason: "quit" }, mockCtx);

    await vi.advanceTimersByTimeAsync(400);
    expect(completeSimple).not.toHaveBeenCalled();
    expect(
      mockCtx.ui.setWidget.mock.calls.some(
        (call: unknown[]) => call[0] === STRIP_KEY_ABOVE && typeof call[1] === "function",
      ),
    ).toBe(false);
  });

  it("turn_end schedules idle recap", async () => {
    const { completeSimple } = await import("@earendil-works/pi-ai");
    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: "text", text: "recap: updated the middleware" }],
    });

    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(() => buildMeaningfulBranch());
    mockCtx.sessionManager.getLeafId = vi.fn(() => "leaf-1");
    await sessionRecapExtension(mockPi);

    // Start session
    const sessionStartHandler = getEventHandler(mockPi, "session_start");
    await sessionStartHandler({ type: "session_start", reason: "new" }, mockCtx);

    // Trigger turn_end
    const turnEndHandler = getEventHandler(mockPi, "turn_end");
    await turnEndHandler({ type: "turn_end", turnIndex: 1, message: {}, toolResults: [] }, mockCtx);

    // Should not call immediately
    expect(completeSimple).not.toHaveBeenCalled();

    // Advance past idle seconds (default 45s)
    vi.advanceTimersByTime(46000);
    await vi.waitFor(() => expect(completeSimple).toHaveBeenCalled());

    expect(mockCtx.ui.setWidget).toHaveBeenCalledWith(STRIP_KEY_ABOVE, expect.any(Function));
  });

  it("input clears recap and cancels idle timer", async () => {
    const { completeSimple } = await import("@earendil-works/pi-ai");
    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: "text", text: "recap: did some work" }],
    });

    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(() => buildMeaningfulBranch());
    mockCtx.sessionManager.getLeafId = vi.fn(() => "leaf-1");
    await sessionRecapExtension(mockPi);

    // Start session and trigger turn_end
    const sessionStartHandler = getEventHandler(mockPi, "session_start");
    await sessionStartHandler({ type: "session_start", reason: "new" }, mockCtx);

    const turnEndHandler = getEventHandler(mockPi, "turn_end");
    await turnEndHandler({ type: "turn_end", turnIndex: 1, message: {}, toolResults: [] }, mockCtx);

    // User types before idle timer fires
    const inputHandler = getEventHandler(mockPi, "input");
    await inputHandler({ type: "input", text: "hello", source: "interactive" }, mockCtx);

    expect(
      mockCtx.ui.setWidget.mock.calls
        .filter(([key]) => key === STRIP_KEY_ABOVE)
        .every(([, content]) => content === undefined),
    ).toBe(true);

    // Advance timers — completeSimple should NOT be called because timer was cleared
    vi.advanceTimersByTime(60000);
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("publishes recap:changed on the event bus when the widget shows and clears", async () => {
    const { completeSimple } = await import("@earendil-works/pi-ai");
    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: "text", text: "recap: did some work" }],
    });

    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(() => buildMeaningfulBranch());
    mockCtx.sessionManager.getLeafId = vi.fn(() => "leaf-1");
    await sessionRecapExtension(mockPi);

    const sessionStartHandler = getEventHandler(mockPi, "session_start");
    await sessionStartHandler({ type: "session_start", reason: "new" }, mockCtx);

    const turnEndHandler = getEventHandler(mockPi, "turn_end");
    await turnEndHandler({ type: "turn_end", turnIndex: 1, message: {}, toolResults: [] }, mockCtx);

    vi.advanceTimersByTime(46000);
    await vi.waitFor(() =>
      expect(mockPi.events.emit).toHaveBeenCalledWith("recap:changed", { visible: true }),
    );

    const inputHandler = getEventHandler(mockPi, "input");
    await inputHandler({ type: "input", text: "hello", source: "interactive" }, mockCtx);

    expect(mockPi.events.emit).toHaveBeenCalledWith("recap:changed", { visible: false });
  });

  it("agent_start sets active state and clears recap", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await sessionRecapExtension(mockPi);

    const agentStartHandler = getEventHandler(mockPi, "agent_start");
    await agentStartHandler({ type: "agent_start" }, mockCtx);

    expect(
      mockCtx.ui.setWidget.mock.calls
        .filter(([key]) => key === STRIP_KEY_ABOVE)
        .every(([, content]) => content === undefined),
    ).toBe(true);
  });

  it("agent_end triggers deferred focus recap", async () => {
    const tty = mockTTY();
    const { completeSimple } = await import("@earendil-works/pi-ai");
    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: "text", text: "recap: completed the task" }],
    });

    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(() => buildMeaningfulBranch());
    mockCtx.sessionManager.getLeafId = vi.fn(() => "leaf-1");
    await sessionRecapExtension(mockPi);

    // Start session (attaches focus reporting)
    const sessionStartHandler = getEventHandler(mockPi, "session_start");
    await sessionStartHandler({ type: "session_start", reason: "new" }, mockCtx);

    // Agent starts (active)
    const agentStartHandler = getEventHandler(mockPi, "agent_start");
    await agentStartHandler({ type: "agent_start" }, mockCtx);

    // Simulate focus out while agent is active
    const listener = tty.capturedListener;
    expect(listener).toBeDefined();
    listener!(Buffer.from("\x1b[O"));

    // Agent ends — should trigger deferred focus recap
    const agentEndHandler = getEventHandler(mockPi, "agent_end");
    await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);

    await vi.waitFor(() => expect(completeSimple).toHaveBeenCalled());
  });

  it("turn_start cancels pending idle recap", async () => {
    const { completeSimple } = await import("@earendil-works/pi-ai");
    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: "text", text: "recap: some work" }],
    });

    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(() => buildMeaningfulBranch());
    mockCtx.sessionManager.getLeafId = vi.fn(() => "leaf-1");
    await sessionRecapExtension(mockPi);

    const sessionStartHandler = getEventHandler(mockPi, "session_start");
    await sessionStartHandler({ type: "session_start", reason: "new" }, mockCtx);

    const turnEndHandler = getEventHandler(mockPi, "turn_end");
    await turnEndHandler({ type: "turn_end", turnIndex: 1, message: {}, toolResults: [] }, mockCtx);

    // Another turn starts before idle timer fires
    const turnStartHandler = getEventHandler(mockPi, "turn_start");
    await turnStartHandler({ type: "turn_start", turnIndex: 2, timestamp: Date.now() });

    // Advance timers — should not fire because turn_start cleared it
    vi.advanceTimersByTime(60000);
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("/recap command generates manual recap", async () => {
    const { completeSimple } = await import("@earendil-works/pi-ai");
    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: "text", text: "recap: manual recap here" }],
    });

    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(() => buildMeaningfulBranch());
    mockCtx.sessionManager.getLeafId = vi.fn(() => "leaf-1");
    await sessionRecapExtension(mockPi);

    const handler = getCommandHandler(mockPi, "recap");
    await handler("", mockCtx);

    await vi.waitFor(() => expect(completeSimple).toHaveBeenCalled());
    expect(mockCtx.ui.setWidget).toHaveBeenCalledWith(STRIP_KEY_ABOVE, expect.any(Function));

    // Verify the factory renders content with the recap text
    const factory = (mockCtx.ui.setWidget as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === STRIP_KEY_ABOVE && typeof c[1] === "function",
    )?.[1] as ((tui: unknown, theme: unknown) => unknown) | undefined;
    expect(factory).toBeDefined();
    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
    const component = factory!(null, theme) as { render: (w: number) => string[] };
    const lines = component.render(80);
    expect(lines.some((l: string) => l.includes("manual recap here"))).toBe(true);
  });

  it("idle recap firing mid-generation does not abort an in-flight /recap", async () => {
    const { completeSimple } = await import("@earendil-works/pi-ai");
    const { gated, release: releaseGeneration } = gateGeneration();
    vi.mocked(completeSimple).mockImplementationOnce(() => gated);

    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(() => buildMeaningfulBranch());
    mockCtx.sessionManager.getLeafId = vi.fn(() => "leaf-1");
    await sessionRecapExtension(mockPi);

    // Slash commands run before the input event, so the idle timer survives
    // typing /recap and can fire while the manual recap is generating.
    const recapDone = getCommandHandler(mockPi, "recap")("", mockCtx);
    await vi.waitFor(() => expect(completeSimple).toHaveBeenCalledTimes(1));

    const turnEndHandler = getEventHandler(mockPi, "turn_end");
    await turnEndHandler({ type: "turn_end", turnIndex: 1, message: {}, toolResults: [] }, mockCtx);
    vi.advanceTimersByTime(46000);

    // The idle trigger must yield to the manual recap, not abort it
    expect(completeSimple).toHaveBeenCalledTimes(1);

    releaseGeneration({ content: [{ type: "text", text: "recap: manual wins" }] });
    await recapDone;

    expect(mockCtx.ui.setWidget).toHaveBeenCalledWith(STRIP_KEY_ABOVE, expect.any(Function));
  });

  it("/recap with an empty transcript notifies instead of silently doing nothing", async () => {
    const { completeSimple } = await import("@earendil-works/pi-ai");

    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(() => []);
    await sessionRecapExtension(mockPi);

    await getCommandHandler(mockPi, "recap")("", mockCtx);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith("Nothing to recap yet.", "info");
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("/recap reports when generation returns no output", async () => {
    const { completeSimple } = await import("@earendil-works/pi-ai");
    vi.mocked(completeSimple).mockResolvedValueOnce({ content: [] });

    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(() => buildMeaningfulBranch());
    mockCtx.sessionManager.getLeafId = vi.fn(() => "leaf-1");
    await sessionRecapExtension(mockPi);

    await getCommandHandler(mockPi, "recap")("", mockCtx);

    await vi.waitFor(() => expect(completeSimple).toHaveBeenCalled());
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      "Recap generation returned no output.",
      "warning",
    );
    expect(mockCtx.ui.setWidget).not.toHaveBeenCalledWith(
      "session-recap",
      expect.any(Function),
      expect.anything(),
    );
  });

  it("/recap still shows when only a custom entry (e.g. todos-state) is appended during generation", async () => {
    const { completeSimple } = await import("@earendil-works/pi-ai");
    const { gated, release: releaseGeneration } = gateGeneration();
    vi.mocked(completeSimple).mockImplementationOnce(() => gated);

    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(() => buildMeaningfulBranch());
    mockCtx.sessionManager.getLeafId = vi.fn(() => "leaf-1");
    await sessionRecapExtension(mockPi);

    const recapDone = getCommandHandler(mockPi, "recap")("", mockCtx);
    await vi.waitFor(() => expect(completeSimple).toHaveBeenCalled());

    // Simulate the todo tool persisting state mid-generation: the leaf
    // advances but no new conversation content appears.
    mockCtx.sessionManager.getLeafId = vi.fn(() => "leaf-2");
    mockCtx.sessionManager.getBranch = vi.fn(() => [
      ...buildMeaningfulBranch(),
      { type: "custom", customType: "todos-state", data: { items: [] } },
    ]);

    releaseGeneration({ content: [{ type: "text", text: "recap: not stale" }] });
    await recapDone;

    expect(mockCtx.ui.setWidget).toHaveBeenCalledWith(STRIP_KEY_ABOVE, expect.any(Function));
  });

  it("/recap drops the recap when a new message lands during generation", async () => {
    const { completeSimple } = await import("@earendil-works/pi-ai");
    const { gated, release: releaseGeneration } = gateGeneration();
    vi.mocked(completeSimple).mockImplementationOnce(() => gated);

    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(() => buildMeaningfulBranch());
    mockCtx.sessionManager.getLeafId = vi.fn(() => "leaf-1");
    await sessionRecapExtension(mockPi);

    const recapDone = getCommandHandler(mockPi, "recap")("", mockCtx);
    await vi.waitFor(() => expect(completeSimple).toHaveBeenCalled());

    // A new user message means the conversation moved on; the recap is stale.
    mockCtx.sessionManager.getLeafId = vi.fn(() => "leaf-2");
    mockCtx.sessionManager.getBranch = vi.fn(() => [
      ...buildMeaningfulBranch(),
      {
        type: "message",
        id: "msg-3",
        message: { role: "user", content: [{ type: "text", text: "new question" }] },
      },
    ]);

    releaseGeneration({ content: [{ type: "text", text: "recap: stale" }] });
    await recapDone;

    expect(mockCtx.ui.setWidget).not.toHaveBeenCalledWith(
      "session-recap",
      expect.any(Function),
      expect.anything(),
    );
  });

  it("uses the global small model instead of the active model", async () => {
    const { completeSimple } = await import("@earendil-works/pi-ai");
    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: "text", text: "recap: used the small model" }],
    });
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    const activeModel = mockCtx.model;
    const smallModel = {
      ...activeModel,
      id: "small-model",
      provider: "small-provider",
      reasoning: true,
    };
    vi.stubEnv("PI_SMALL_MODEL", "small-provider/small-model");
    mockCtx.modelRegistry.find = vi.fn(() => smallModel);
    mockCtx.sessionManager.getBranch = vi.fn(() => buildMeaningfulBranch());
    mockCtx.sessionManager.getLeafId = vi.fn(() => "leaf-1");
    await sessionRecapExtension(mockPi);

    await getCommandHandler(mockPi, "recap")("", mockCtx);
    await vi.waitFor(() => expect(completeSimple).toHaveBeenCalled());

    expect(completeSimple).toHaveBeenCalledWith(
      smallModel,
      expect.anything(),
      expect.objectContaining({ apiKey: "test-key", reasoning: "minimal", maxTokens: 256 }),
    );
    expect(completeSimple).not.toHaveBeenCalledWith(
      activeModel,
      expect.anything(),
      expect.anything(),
    );
  });

  it("manual recap reports an unavailable global small model without falling back", async () => {
    const { completeSimple } = await import("@earendil-works/pi-ai");
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.modelRegistry.find = vi.fn(() => undefined);
    mockCtx.sessionManager.getBranch = vi.fn(() => buildMeaningfulBranch());
    mockCtx.sessionManager.getLeafId = vi.fn(() => "leaf-1");
    await sessionRecapExtension(mockPi);

    await getCommandHandler(mockPi, "recap")("", mockCtx);
    await vi.waitFor(() =>
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Global small model not found"),
        "error",
      ),
    );

    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("does not generate recap when there is no meaningful activity", async () => {
    const { completeSimple } = await import("@earendil-works/pi-ai");
    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: "text", text: "recap: no activity" }],
    });

    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    // Branch with only a short assistant message (< 30 words)
    mockCtx.sessionManager.getBranch = vi.fn(() => [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok done" }],
        },
      },
    ]);
    mockCtx.sessionManager.getLeafId = vi.fn(() => "leaf-1");
    await sessionRecapExtension(mockPi);

    const sessionStartHandler = getEventHandler(mockPi, "session_start");
    await sessionStartHandler({ type: "session_start", reason: "new" }, mockCtx);

    const turnEndHandler = getEventHandler(mockPi, "turn_end");
    await turnEndHandler({ type: "turn_end", turnIndex: 1, message: {}, toolResults: [] }, mockCtx);

    vi.advanceTimersByTime(60000);
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("session_shutdown detaches focus reporting and clears state", async () => {
    const tty = mockTTY();
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await sessionRecapExtension(mockPi);

    // Start session to attach focus
    const sessionStartHandler = getEventHandler(mockPi, "session_start");
    await sessionStartHandler({ type: "session_start", reason: "new" }, mockCtx);

    expect(tty.stdoutWrite).toHaveBeenCalledWith("\x1b[?1004h");

    // Shutdown
    const shutdownHandler = getEventHandler(mockPi, "session_shutdown");
    await shutdownHandler({ type: "session_shutdown", reason: "quit" }, mockCtx);

    expect(tty.stdoutWrite).toHaveBeenLastCalledWith("\x1b[?1004l");
    expect(tty.stdinOff).toHaveBeenCalled();
    expect(
      mockCtx.ui.setWidget.mock.calls
        .filter(([key]) => key === STRIP_KEY_ABOVE)
        .every(([, content]) => content === undefined),
    ).toBe(true);
  });

  it("focus out during active agent defers recap", async () => {
    const tty = mockTTY();
    const { completeSimple } = await import("@earendil-works/pi-ai");
    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: "text", text: "recap: completed the task" }],
    });

    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(() => buildMeaningfulBranch());
    mockCtx.sessionManager.getLeafId = vi.fn(() => "leaf-1");
    await sessionRecapExtension(mockPi);

    // Start session
    const sessionStartHandler = getEventHandler(mockPi, "session_start");
    await sessionStartHandler({ type: "session_start", reason: "new" }, mockCtx);

    // Agent active
    const agentStartHandler = getEventHandler(mockPi, "agent_start");
    await agentStartHandler({ type: "agent_start" }, mockCtx);

    // Focus out
    const listener = tty.capturedListener;
    expect(listener).toBeDefined();
    listener!(Buffer.from("\x1b[O"));

    // Should NOT call completeSimple yet (deferred)
    expect(completeSimple).not.toHaveBeenCalled();

    // Agent ends
    const agentEndHandler = getEventHandler(mockPi, "agent_end");
    await agentEndHandler({ type: "agent_end", messages: [] }, mockCtx);

    // Now it should call
    await vi.waitFor(() => expect(completeSimple).toHaveBeenCalled());
  });

  it("quick focus glance does not show recap", async () => {
    const tty = mockTTY();
    const { completeSimple } = await import("@earendil-works/pi-ai");
    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: "text", text: "recap: some work done" }],
    });

    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(() => buildMeaningfulBranch());
    mockCtx.sessionManager.getLeafId = vi.fn(() => "leaf-1");
    await sessionRecapExtension(mockPi);

    const sessionStartHandler = getEventHandler(mockPi, "session_start");
    await sessionStartHandler({ type: "session_start", reason: "new" }, mockCtx);

    // Focus out
    const listener = tty.capturedListener;
    expect(listener).toBeDefined();
    listener!(Buffer.from("\x1b[O"));

    // Wait for recap to be generated
    await vi.waitFor(() => expect(completeSimple).toHaveBeenCalled());

    // Focus back in quickly (< 3s min)
    vi.advanceTimersByTime(1000);
    listener!(Buffer.from("\x1b[I"));

    // Should not show the recap
    const recapCalls = (mockCtx.ui.setWidget as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === "session-recap" && call[1] !== undefined,
    );
    expect(recapCalls.length).toBe(0);
  });

  // --- Wrapping tests ---

  it("wraps long recap text via render width", async () => {
    const { completeSimple } = await import("@earendil-works/pi-ai");
    const longRecap = `recap: ${"x".repeat(300)}. Next: do something.`;
    vi.mocked(completeSimple).mockResolvedValueOnce({
      content: [{ type: "text", text: longRecap }],
    });

    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(() => buildMeaningfulBranch());
    mockCtx.sessionManager.getLeafId = vi.fn(() => "leaf-1");
    await sessionRecapExtension(mockPi);

    const handler = getCommandHandler(mockPi, "recap");
    await handler("", mockCtx);

    await vi.waitFor(() => expect(completeSimple).toHaveBeenCalled());

    // Check that the factory widget was set
    const widgetCalls = (mockCtx.ui.setWidget as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => call[0] === STRIP_KEY_ABOVE && typeof call[1] === "function",
    );
    expect(widgetCalls.length).toBeGreaterThan(0);

    // Verify the factory wraps text at a narrow width
    const factory = widgetCalls[0]![1] as (tui: unknown, theme: unknown) => unknown;
    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
    const component = factory(null, theme) as { render: (w: number) => string[] };
    const lines = component.render(40);
    // header line + at least one text line
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toContain("recap"); // header
  });
});

function gateGeneration(): {
  gated: Promise<{ content: Array<{ type: string; text: string }> }>;
  release: (value: { content: Array<{ type: string; text: string }> }) => void;
} {
  let release!: (value: { content: Array<{ type: string; text: string }> }) => void;
  const gated = new Promise<{ content: Array<{ type: string; text: string }> }>((resolve) => {
    release = resolve;
  });
  return { gated, release };
}
