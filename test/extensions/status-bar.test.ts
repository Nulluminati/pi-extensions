import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import statusBarExtension, {
  buildEditorMetaSegments,
  renderEditorModalFrame,
  STATUS_ICON,
} from "../../extensions/status-bar/status-bar.ts";
import {
  type EditorFactory,
  hasEditorFactoryLayer,
  installEditorFactoryLayer,
} from "../../lib/editor-factory.ts";
import { loadSmallModelConfig, resolveSmallModelConfigPath } from "../../lib/small-model.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { getEventHandler } from "../mocks/test-helpers.ts";

vi.mock("../../lib/small-model.ts", () => ({
  loadSmallModelConfig: vi.fn(),
  resolveSmallModelConfigPath: vi.fn(() => "/agent/small-model.json"),
}));

/**
 * Default the small-model config mock to "not configured" so the editor meta
 * line omits the small model segment unless a test opts in. Called after
 * vi.resetAllMocks() in each beforeEach, since resetting wipes the impl.
 */
function unconfigureSmallModel(): void {
  vi.mocked(loadSmallModelConfig).mockImplementation(() => {
    throw new Error("not configured");
  });
}

/**
 * Helper: enable the status bar via session_start (the natural activation path).
 * The extension is enabled by default, so session_start sets the footer.
 */
async function enableBar(
  mockPi: ReturnType<typeof createMockPi>,
  mockCtx: ReturnType<typeof createMockCommandContext>,
) {
  await statusBarExtension(mockPi);
  const sessionStartHandler = getEventHandler(mockPi, "session_start");
  await sessionStartHandler({ type: "session_start", reason: "new" }, mockCtx);
}

/**
 * Helper: extract the footer factory from the most recent setFooter call.
 */
function getFooterFactory(mockCtx: ReturnType<typeof createMockCommandContext>) {
  const calls = mockCtx.ui.setFooter.mock.calls;
  // Find the last call that was passed a function (not undefined)
  for (let i = calls.length - 1; i >= 0; i--) {
    if (typeof calls[i][0] === "function") return calls[i][0];
  }
  throw new Error("No setFooter(factory) call found");
}

/** Minimal theme that returns text unchanged for assertions. */
function plainTheme() {
  return { fg: vi.fn((_color: string, text: string) => text) };
}

/** Mock footer data with overridable git branch / extension statuses. */
function footerData(opts: { branch?: string | null; statuses?: Map<string, string> } = {}) {
  return {
    onBranchChange: vi.fn(() => vi.fn()),
    getGitBranch: vi.fn(() => opts.branch ?? null),
    getExtensionStatuses: vi.fn(() => opts.statuses ?? new Map()),
  };
}

/** Helper: extract a pi.events bus handler registered by the extension. */
function getEventsHandler(mockPi: ReturnType<typeof createMockPi>, eventName: string) {
  const call = mockPi.events.on.mock.calls.find((c) => c[0] === eventName);
  if (!call) throw new Error(`No pi.events handler for ${eventName}`);
  return call[1] as (payload: any) => void;
}

/**
 * Mock pi.exec for git: returns porcelain-v2 stdout for `status`, and the
 * given stash stdout for `rev-parse --verify refs/stash`.
 */
function mockGitExec(porcelainStdout: string, opts: { stash?: string; code?: number } = {}) {
  const stash = opts.stash ?? "";
  const code = opts.code ?? 0;
  return vi.fn((_cmd: string, args: string[]) => {
    if (args.includes("rev-parse")) {
      return Promise.resolve({
        stdout: stash,
        stderr: "",
        code: stash ? 0 : 1,
        killed: false,
      });
    }
    return Promise.resolve({ stdout: porcelainStdout, stderr: "", code, killed: false });
  });
}

describe("status-bar-extension", () => {
  describe("file structure", () => {
    it("keeps one discoverable entrypoint and implementation modules under src", async () => {
      const extensionDir = resolve(import.meta.dirname, "../../extensions/status-bar");
      const rootEntries = await readdir(extensionDir, { withFileTypes: true });
      const rootTypeScriptFiles = rootEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => entry.name);
      const sourceFiles = await readdir(resolve(extensionDir, "src"));

      expect(rootTypeScriptFiles).toEqual(["status-bar.ts"]);
      expect(sourceFiles.filter((file) => file.endsWith(".ts"))).toHaveLength(5);
    });
  });

  beforeEach(() => {
    vi.resetAllMocks();
    unconfigureSmallModel();
  });

  it("registers /statusbar:toggle command", async () => {
    const mockPi = createMockPi();
    await statusBarExtension(mockPi);
    expect(mockPi.registerCommand).toHaveBeenCalledWith(
      "statusbar:toggle",
      expect.objectContaining({
        description: expect.any(String),
        handler: expect.any(Function),
      }),
    );
  });

  it("registers event handlers for state tracking", async () => {
    const mockPi = createMockPi();
    await statusBarExtension(mockPi);
    expect(mockPi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith("turn_start", expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith("turn_end", expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith("message_end", expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith("model_select", expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith("thinking_level_select", expect.any(Function));
  });

  it("is enabled by default on session_start", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);
    expect(mockCtx.ui.setFooter).toHaveBeenCalledWith(expect.any(Function));
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith(
      "status-bar",
      expect.stringContaining("Status Bar: enabled"),
    );
  });

  it("/statusbar:toggle disables the footer when already enabled", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("", mockCtx);

    expect(mockCtx.ui.setFooter).toHaveBeenCalledWith(undefined);
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("status-bar", undefined);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("disabled"), "info");
  });

  it("/statusbar:toggle re-enables the footer after being disabled", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("", mockCtx); // disable
    await handler("", mockCtx); // re-enable

    expect(mockCtx.ui.setFooter).toHaveBeenLastCalledWith(expect.any(Function));
    expect(mockCtx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("enabled"), "info");
  });

  it("session_start resets turn count and re-enables footer", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const turnStartHandler = getEventHandler(mockPi, "turn_start");
    await turnStartHandler({ type: "turn_start", turnIndex: 0, timestamp: Date.now() }, mockCtx);
    await turnStartHandler({ type: "turn_start", turnIndex: 1, timestamp: Date.now() }, mockCtx);

    // Re-fire session_start
    const sessionStartHandler = getEventHandler(mockPi, "session_start");
    await sessionStartHandler({ type: "session_start", reason: "new" }, mockCtx);

    // setFooter called: once from initial enableBar, once from this session_start
    const footerFactoryCalls = mockCtx.ui.setFooter.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "function",
    ).length;
    expect(footerFactoryCalls).toBe(2);
  });

  it("installs footer and editor before git status resolves", async () => {
    // Regression: the polished editor frame and footer must be installed on the
    // first paint, not after the async git refresh. Hold git pending and assert
    // the installs have already happened.
    const resolvers: Array<() => void> = [];
    const mockPi = createMockPi();
    mockPi.exec = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvers.push(() => resolve({ stdout: "", stderr: "", code: 0, killed: false }));
        }),
    );
    const mockCtx = createMockCommandContext();

    await statusBarExtension(mockPi);
    const sessionStartHandler = getEventHandler(mockPi, "session_start");
    const pending = sessionStartHandler({ type: "session_start", reason: "new" }, mockCtx);

    // Let synchronous work and microtasks settle while git stays pending.
    await new Promise((r) => setTimeout(r, 0));

    expect(mockCtx.ui.setFooter).toHaveBeenCalledWith(expect.any(Function));
    expect(mockCtx.ui.setEditorComponent).toHaveBeenCalledWith(expect.any(Function));

    // Release git so the handler completes and no promise is left dangling.
    for (const resolve of resolvers) resolve();
    await pending;
  });

  it("session_shutdown clears the footer", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const shutdownHandler = getEventHandler(mockPi, "session_shutdown");
    await shutdownHandler({ type: "session_shutdown", reason: "quit" }, mockCtx);

    expect(mockCtx.ui.setFooter).toHaveBeenCalledWith(undefined);
  });

  // --- Line 1: static segments (model + thinking live in the editor box) ---

  it("footer does not show the model label (it lives in the editor box)", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.model = {
      ...mockCtx.model,
      id: "claude-sonnet-4-6",
      provider: "anthropic",
      // biome-ignore lint/suspicious/noExplicitAny: test mock
    } as any;
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData({ branch: "main" }),
    );
    const lines = component.render(120);

    expect(lines[0]).not.toContain("anthropic/claude-sonnet-4-6");
    expect(lines[0]).toContain("main");
  });

  it("footer omits the provider/model label", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    mockCtx.model = { id: "gpt-4o", provider: "openai" } as any;
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    const lines = component.render(120);

    expect(lines[0]).not.toContain("openai/gpt-4o");
  });

  it("footer shows working directory basename on line 1", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.cwd = "/home/user/projects/my-app";
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    const lines = component.render(120);

    expect(lines[0]).toContain("my-app");
  });

  it("renders the Nerd Font folder icon before the cwd", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.cwd = "/home/user/projects/my-app";
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    const lines = component.render(120);

    const folder = String.fromCodePoint(0xf0770);
    expect(lines[0]).toContain(folder);
  });

  it("renders the Nerd Font git icon before the branch", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData({ branch: "main" }),
    );
    const lines = component.render(120);

    const git = String.fromCodePoint(0xf418);
    expect(lines[0]).toContain(git);
  });

  it("footer shows context usage bar when available", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.getContextUsage = vi.fn(() => ({
      tokens: 50000,
      contextWindow: 200000,
      percent: 25,
    }));
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    const lines = component.render(120);

    expect(lines[0]).toContain("50.0k/200.0k");
  });

  it("clamps usage bar when context exceeds window (e.g. continued session)", async () => {
    // Regression: continuing a session whose context is already larger than
    // the selected model's window yields percent > 100, which made
    // String.repeat receive a negative count and crashed pi at boot.
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.getContextUsage = vi.fn(() => ({
      tokens: 262000,
      contextWindow: 200000,
      percent: 131,
    }));
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );

    // Must not throw RangeError: Invalid count value (negative repeat).
    const lines = component.render(120);
    expect(lines[0]).toContain("262.0k/200.0k");
    // Bar is fully filled (10 blocks) rather than crashing.
    expect(lines[0]).toContain("[██████████]");
  });

  it("does not re-query context usage on every render (cached, refreshed on events)", async () => {
    // Context usage is O(conversation) to compute; the footer must cache it and
    // refresh only when messages land, not call ctx.getContextUsage() per render.
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.getContextUsage = vi.fn(() => ({
      tokens: 50000,
      contextWindow: 200000,
      percent: 25,
    }));
    await enableBar(mockPi, mockCtx);
    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );

    // session_start refreshed the cache once; renders must not re-query.
    mockCtx.getContextUsage.mockClear();
    component.render(120);
    component.render(120);
    component.render(120);
    expect(mockCtx.getContextUsage).not.toHaveBeenCalled();

    // The cached value still renders.
    expect(component.render(120)[0]).toContain("50.0k/200.0k");
  });

  it("refreshes cached context usage when a message lands", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.getContextUsage = vi.fn(() => ({
      tokens: 1000,
      contextWindow: 200000,
      percent: 1,
    }));
    await enableBar(mockPi, mockCtx);
    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    expect(component.render(120)[0]).toContain("1.0k/200.0k");

    // A new assistant message grows the context; the cache must refresh.
    mockCtx.getContextUsage = vi.fn(() => ({
      tokens: 80000,
      contextWindow: 200000,
      percent: 40,
    }));
    const messageEnd = getEventHandler(mockPi, "message_end");
    await messageEnd({ type: "message_end", message: { role: "assistant" } }, mockCtx);

    expect(component.render(120)[0]).toContain("80.0k/200.0k");
    mockCtx.getContextUsage.mockClear();
    component.render(120);
    expect(mockCtx.getContextUsage).not.toHaveBeenCalled();
  });

  it("token indicators use distinct colors per bucket", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.getContextUsage = vi.fn(() => ({
      tokens: 1000,
      contextWindow: 200000,
      percent: 0.5,
    }));
    mockCtx.sessionManager.getBranch = vi.fn(() => [
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.001 } },
        },
      },
    ]);
    await enableBar(mockPi, mockCtx);

    const turnEndHandler = getEventHandler(mockPi, "turn_end");
    await turnEndHandler({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, mockCtx);

    const fgMock = vi.fn((_color: string, text: string) => text);
    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      { fg: fgMock },
      footerData(),
    );
    component.render(120);

    expect(fgMock).toHaveBeenCalledWith("accent", "↑1");
    expect(fgMock).toHaveBeenCalledWith("mdHeading", "↓2");
    expect(fgMock).toHaveBeenCalledWith("mdLink", "↗3");
    expect(fgMock).toHaveBeenCalledWith("thinkingHigh", "↘4");
  });

  it("turn_start increments turn count and shows in footer", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const turnStartHandler = getEventHandler(mockPi, "turn_start");
    await turnStartHandler({ type: "turn_start", turnIndex: 0, timestamp: Date.now() }, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    const lines = component.render(120);

    expect(lines[0]).toContain("↻1");
  });

  it("turn count sits on the right side, after the token counters", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.getContextUsage = vi.fn(() => ({
      tokens: 5000,
      contextWindow: 200000,
      percent: 2.5,
    }));
    mockCtx.sessionManager.getBranch = vi.fn(() => [
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
        },
      },
    ]);
    await enableBar(mockPi, mockCtx);

    const turnEndHandler = getEventHandler(mockPi, "turn_end");
    await turnEndHandler({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, mockCtx);
    const turnStartHandler = getEventHandler(mockPi, "turn_start");
    await turnStartHandler({ type: "turn_start", turnIndex: 0, timestamp: Date.now() }, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    const lines = component.render(160);
    const line = lines[0];

    const turnIdx = line.indexOf("↻");
    const tokenIdx = line.indexOf("↑");
    expect(turnIdx).toBeGreaterThan(-1);
    expect(tokenIdx).toBeGreaterThan(-1);
    // Turn count is to the right of the token counters.
    expect(turnIdx).toBeGreaterThan(tokenIdx);
  });

  it("turn_end accumulates token usage on line 1", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.getContextUsage = vi.fn(() => ({
      tokens: 5000,
      contextWindow: 200000,
      percent: 2.5,
    }));
    mockCtx.sessionManager.getBranch = vi.fn(() => [
      {
        type: "message",
        message: {
          role: "assistant",
          usage: {
            input: 1000,
            output: 500,
            cacheRead: 200,
            cacheWrite: 100,
            cost: { total: 0.03 },
          },
        },
      },
    ]);
    await enableBar(mockPi, mockCtx);

    const turnEndHandler = getEventHandler(mockPi, "turn_end");
    await turnEndHandler({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    const lines = component.render(160);

    expect(lines[0]).toContain("↑1.0k");
    expect(lines[0]).toContain("↓500");
    expect(lines[0]).toContain("↗200");
    expect(lines[0]).toContain("↘100");
    expect(lines[0]).toContain("$0.030");
  });

  it("token details accumulate across multiple assistant messages", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.getContextUsage = vi.fn(() => ({
      tokens: 5000,
      contextWindow: 200000,
      percent: 2.5,
    }));
    mockCtx.sessionManager.getBranch = vi.fn(() => [
      {
        type: "message",
        message: {
          role: "assistant",
          usage: {
            input: 1000,
            output: 500,
            cacheRead: 200,
            cacheWrite: 100,
            cost: { total: 0.02 },
          },
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          usage: {
            input: 2000,
            output: 1000,
            cacheRead: 300,
            cacheWrite: 0,
            cost: { total: 0.03 },
          },
        },
      },
    ]);
    await enableBar(mockPi, mockCtx);

    const turnEndHandler = getEventHandler(mockPi, "turn_end");
    await turnEndHandler({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    const lines = component.render(160);

    expect(lines[0]).toContain("↑3.0k");
    expect(lines[0]).toContain("↓1.5k");
    expect(lines[0]).toContain("↗500");
    expect(lines[0]).toContain("↘100");
    expect(lines[0]).toContain("$0.050");
  });

  it("token details always show cacheRead/cacheWrite, even at zero", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.getContextUsage = vi.fn(() => ({
      tokens: 1000,
      contextWindow: 200000,
      percent: 0.5,
    }));
    mockCtx.sessionManager.getBranch = vi.fn(() => [
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
        },
      },
    ]);
    await enableBar(mockPi, mockCtx);

    const turnEndHandler = getEventHandler(mockPi, "turn_end");
    await turnEndHandler({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    const lines = component.render(120);

    expect(lines[0]).toContain("↑1.0k");
    expect(lines[0]).toContain("↓500");
    expect(lines[0]).toContain("↗0");
    expect(lines[0]).toContain("↘0");
  });

  it("token indicators show 0 at the start instead of being hidden", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(() => []);
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    const lines = component.render(120);

    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("↑0");
    expect(lines[0]).toContain("↓0");
    expect(lines[0]).toContain("↗0");
    expect(lines[0]).toContain("↘0");
  });

  it("cost shows $0.000 at the start instead of being hidden", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(() => []);
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    const lines = component.render(120);

    expect(lines[0]).toContain("$0.000");
  });

  it("cost rounds to three decimals", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(() => [
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01234 } },
        },
      },
    ]);
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    const lines = component.render(120);

    expect(lines[0]).toContain("$0.012");
  });

  it("message_end accumulates token usage", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.getContextUsage = vi.fn(() => ({
      tokens: 500,
      contextWindow: 200000,
      percent: 0.25,
    }));
    mockCtx.sessionManager.getBranch = vi.fn(() => [
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
        },
      },
    ]);
    await enableBar(mockPi, mockCtx);

    const messageEndHandler = getEventHandler(mockPi, "message_end");
    await messageEndHandler({ type: "message_end", message: { role: "assistant" } }, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    const lines = component.render(120);

    expect(lines[0]).toContain("↑500");
  });

  it("editor metadata line color-codes the thinking level (low/medium/high)", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    for (const [level, color] of [
      ["low", "thinkingLow"],
      ["medium", "thinkingMedium"],
      ["high", "thinkingHigh"],
    ] as const) {
      mockPi.getThinkingLevel = vi.fn(() => level);
      const fgMock = vi.fn((_c: string, t: string) => t);
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      (mockCtx.ui as any).theme = { fg: fgMock };
      const editor = renderInstalledEditor(mockCtx);
      editor.render(80);
      expect(fgMock).toHaveBeenCalledWith(color, expect.stringContaining(level));
    }
  });

  // --- Git status indicators (Starship-style) ---

  it("git status shows branch with no indicator block when clean", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockPi.exec = mockGitExec("# branch.head main\n# branch.ab +0 -0\n");
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData({ branch: "main" }),
    );
    const lines = component.render(120);

    expect(lines[0]).toContain("main");
    expect(lines[0]).not.toContain("[");
  });

  it("git status shows staged, modified, and untracked indicators", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockPi.exec = mockGitExec(
      [
        "# branch.head develop",
        "# branch.ab +0 -0",
        "1 M. N... 100644 100644 100644 a b staged-file.ts",
        "1 .M N... 100644 100644 100644 a b unstaged-file.ts",
        "? newfile.ts",
      ].join("\n"),
    );
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData({ branch: "develop" }),
    );
    const lines = component.render(120);

    expect(lines[0]).toContain("[");
    expect(lines[0]).toContain("!");
    expect(lines[0]).toContain("+");
    expect(lines[0]).toContain("?");
  });

  it("git status indicator block uses the error color", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockPi.exec = mockGitExec(
      [
        "# branch.head main",
        "# branch.ab +0 -0",
        "1 .M N... 100644 100644 100644 a b file.ts",
      ].join("\n"),
    );
    await enableBar(mockPi, mockCtx);

    const fgMock = vi.fn((_color: string, text: string) => text);
    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      { fg: fgMock },
      footerData({ branch: "main" }),
    );
    component.render(120);

    expect(fgMock).toHaveBeenCalledWith("error", expect.stringContaining("["));
  });

  it("git status shows ahead indicator when ahead of remote", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockPi.exec = mockGitExec("# branch.head main\n# branch.ab +3 -0\n");
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData({ branch: "main" }),
    );
    const lines = component.render(120);

    expect(lines[0]).toContain("↑");
  });

  it("git status shows behind indicator when behind remote", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockPi.exec = mockGitExec("# branch.head main\n# branch.ab +0 -2\n");
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData({ branch: "main" }),
    );
    const lines = component.render(120);

    expect(lines[0]).toContain("↓");
  });

  it("git status shows diverged indicator when ahead and behind", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockPi.exec = mockGitExec("# branch.head main\n# branch.ab +3 -2\n");
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData({ branch: "main" }),
    );
    const lines = component.render(120);

    expect(lines[0]).toContain("⇕");
  });

  it("git status shows stashed indicator when a stash exists", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockPi.exec = mockGitExec("# branch.head main\n# branch.ab +0 -0\n", {
      stash: "abc123\n",
    });
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData({ branch: "main" }),
    );
    const lines = component.render(120);

    expect(lines[0]).toContain("$");
  });

  it("git status shows conflicted indicator for unmerged files", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockPi.exec = mockGitExec(
      ["# branch.head main", "# branch.ab +0 -0", "u N... 100644 a b c d file.ts"].join("\n"),
    );
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData({ branch: "main" }),
    );
    const lines = component.render(120);

    expect(lines[0]).toContain("=");
  });

  it("git status handles non-git directory gracefully", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockPi.exec = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "fatal: not a git repository",
      code: 128,
      killed: false,
    });
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData({ branch: null }),
    );
    const lines = component.render(120);

    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).not.toContain("[");
  });

  it("git status refreshes (porcelain + stash) on turn_end", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockPi.exec = mockGitExec("# branch.head main\n# branch.ab +0 -0\n");
    await enableBar(mockPi, mockCtx);

    // Two git calls during session_start: porcelain + stash rev-parse.
    expect(mockPi.exec).toHaveBeenCalledTimes(2);

    const turnEndHandler = getEventHandler(mockPi, "turn_end");
    await turnEndHandler({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, mockCtx);

    // Two more during turn_end.
    expect(mockPi.exec).toHaveBeenCalledTimes(4);
  });

  it("git status refreshes on branch change", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockPi.exec = mockGitExec("# branch.head develop\n# branch.ab +0 -0\n");
    await enableBar(mockPi, mockCtx);

    const footerFactory = getFooterFactory(mockCtx);
    let branchChangeCallback: (() => void) | undefined;
    const mockFooterData = {
      onBranchChange: vi.fn((cb: () => void) => {
        branchChangeCallback = cb;
        return vi.fn();
      }),
      getGitBranch: vi.fn(() => "develop"),
      getExtensionStatuses: vi.fn(() => new Map()),
    };

    footerFactory({ requestRender: vi.fn() }, plainTheme(), mockFooterData);

    mockPi.exec.mockClear();
    branchChangeCallback?.();
    await vi.waitFor(() => {
      expect(mockPi.exec).toHaveBeenCalledTimes(2);
    });
  });

  // --- Line layout ---

  it("footer render respects width limit on every line", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData({ branch: "feature/some-long-branch-name" }),
    );
    const narrowWidth = 60;
    const lines = component.render(narrowWidth);

    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(narrowWidth);
    }
  });

  it("renders a single line when there are no transient events", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData({ statuses: new Map() }),
    );
    const lines = component.render(120);

    expect(lines.length).toBe(1);
  });

  it("renders a second line when extension statuses are present", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData({
        statuses: new Map([
          ["neuralwatt", "🎯 active"],
          ["small-model", "small synthetic/syn:small:text · minimal"],
          ["other", "some status"],
        ]),
      }),
    );
    const lines = component.render(120);

    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("🎯 active");
    // The small model lives in the editor meta line, so it is suppressed here.
    expect(lines[1]).not.toContain("small synthetic/syn:small:text · minimal");
    expect(lines[1]).toContain("some status");
    // Model lives in the editor box, not the footer.
    expect(lines[0]).not.toContain("test-model");
  });

  it("does not show its own status-bar status on line 2", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData({
        statuses: new Map([
          ["status-bar", `${STATUS_ICON} statusbar`],
          ["neuralwatt", "🎯 active"],
        ]),
      }),
    );
    const lines = component.render(120);

    expect(lines[1]).not.toContain(`${STATUS_ICON} statusbar`);
    expect(lines[1]).toContain("🎯 active");
  });

  it("does not show the gondolin status on line 2 (it lives on line 1)", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData({
        statuses: new Map([
          ["gondolin", "cube a1b2c3d4 (/workspace)"],
          ["neuralwatt", "🎯 active"],
        ]),
      }),
    );
    const lines = component.render(120);

    expect(lines[1]).not.toContain("gondolin");
    expect(lines[1]).not.toContain("/workspace");
    expect(lines[1]).toContain("🎯 active");
  });

  it("footer line 1 shows the gondolin workspace segment after the cwd", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const handler = getEventsHandler(mockPi, "gondolin:vm-state");
    handler({ state: "ready", vmId: "abcd1234efgh5678" });

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData({ branch: "main" }),
    );
    const line1 = component.render(120)[0] ?? "";

    expect(line1).toContain("with WS abcd1234");
    // Segment order: cwd, then WS, then git branch.
    expect(line1.indexOf("with WS")).toBeGreaterThan(line1.indexOf("pi-extensions"));
    expect(line1.indexOf("main")).toBeGreaterThan(line1.indexOf("with WS"));
  });

  it("gondolin segment shows starting state before the VM id is known", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const handler = getEventsHandler(mockPi, "gondolin:vm-state");
    handler({ state: "starting" });

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    expect(component.render(120)[0]).toContain("with WS starting");
  });

  it("gondolin segment disappears once the VM stops", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const handler = getEventsHandler(mockPi, "gondolin:vm-state");
    handler({ state: "ready", vmId: "abcd1234efgh5678" });
    handler({ state: "stopped" });

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    expect(component.render(120)[0]).not.toContain("with WS");
  });

  it("onBranchChange triggers requestRender", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const footerFactory = getFooterFactory(mockCtx);
    const mockRequestRender = vi.fn();
    let branchChangeCallback: (() => void) | undefined;
    const mockFooterData = {
      onBranchChange: vi.fn((cb: () => void) => {
        branchChangeCallback = cb;
        return vi.fn();
      }),
      getGitBranch: vi.fn(() => "develop"),
      getExtensionStatuses: vi.fn(() => new Map()),
    };

    footerFactory({ requestRender: mockRequestRender }, plainTheme(), mockFooterData);

    await branchChangeCallback?.();
    expect(mockRequestRender).toHaveBeenCalled();
  });

  it("dispose is wired to onBranchChange unsubscribe", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const footerFactory = getFooterFactory(mockCtx);
    const mockDispose = vi.fn();
    const mockFooterData = {
      onBranchChange: vi.fn(() => mockDispose),
      getGitBranch: vi.fn(() => null),
      getExtensionStatuses: vi.fn(() => new Map()),
    };

    const component = footerFactory({ requestRender: vi.fn() }, plainTheme(), mockFooterData);

    expect(component.dispose).toBe(mockDispose);
  });

  it("no context usage renders without token bar", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.getContextUsage = vi.fn(() => undefined);
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    const lines = component.render(120);

    expect(lines.length).toBeGreaterThanOrEqual(1);
    // No model on the footer (it lives in the editor box); no token bar either.
    expect(lines[0]).not.toContain("test-model");
    expect(lines[0]).not.toContain("50.0k");
  });

  it("footer omits the model when none is set (label lives in the editor box)", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.model = undefined;
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    const lines = component.render(120);

    expect(lines[0]).not.toContain("no-model");
    expect(lines[0]).not.toContain("undefined/");
  });

  it("session_start resets turn count and token usage", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const turnStartHandler = getEventHandler(mockPi, "turn_start");
    await turnStartHandler({ type: "turn_start", turnIndex: 0, timestamp: Date.now() }, mockCtx);
    await turnStartHandler({ type: "turn_start", turnIndex: 1, timestamp: Date.now() }, mockCtx);

    const sessionStartHandler = getEventHandler(mockPi, "session_start");
    await sessionStartHandler({ type: "session_start", reason: "new" }, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    const lines = component.render(120);

    // Only 1 line — turn count and tokens reset, line 2 collapses.
    expect(lines.length).toBe(1);
  });

  it("invalidate is a no-op", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );

    expect(() => component.invalidate()).not.toThrow();
  });

  it("footer omits a provider-less model (label lives in the editor box)", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    mockCtx.model = { id: "my-model", provider: undefined } as any;
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    const lines = component.render(120);

    expect(lines[0]).not.toContain("my-model");
    expect(lines[0]).not.toContain("undefined/");
  });
});

// === Editor modal frame (pure layout) ===

describe("status-bar editor frame", () => {
  function plainTheme() {
    return { fg: vi.fn((_c: string, t: string) => t) };
  }

  /** Simulate the base editor's render output at the modal content width: top
   * border, content, bottom border. */
  function baseOutput(content: string[], width = 34): string[] {
    return ["─".repeat(width), ...content, "─".repeat(width)];
  }

  it("draws a rounded top border carrying the title", () => {
    const lines = renderEditorModalFrame({
      baseRendered: baseOutput(["hello"]),
      autocompleteCount: 0,
      width: 40,
      title: "anthropic/claude",
      theme: plainTheme(),
    });
    expect(lines[0].startsWith("╭")).toBe(true);
    expect(lines[0].endsWith("╮")).toBe(true);
    expect(lines[0]).toContain("anthropic/claude");
  });

  it("draws a rounded bottom border", () => {
    const lines = renderEditorModalFrame({
      baseRendered: baseOutput(["hello"]),
      autocompleteCount: 0,
      width: 40,
      title: "anthropic/claude",
      theme: plainTheme(),
    });
    expect(lines[lines.length - 1].startsWith("╰")).toBe(true);
    expect(lines[lines.length - 1].endsWith("╯")).toBe(true);
  });

  it("wraps content inside side borders with padding", () => {
    const lines = renderEditorModalFrame({
      baseRendered: baseOutput(["hello"]),
      autocompleteCount: 0,
      width: 40,
      title: "anthropic/claude",
      theme: plainTheme(),
    });
    const contentLine = lines.find((l) => l.includes("hello"));
    expect(contentLine).toBeDefined();
    expect(contentLine?.startsWith("│")).toBe(true);
    expect(contentLine?.endsWith("│")).toBe(true);
    // The base editor's own borders are stripped — content appears once.
    expect(lines.filter((l) => l.includes("hello"))).toHaveLength(1);
  });

  it("places autocomplete below the box", () => {
    const ac1 = "  cmd1  description";
    const ac2 = "  cmd2  description";
    const lines = renderEditorModalFrame({
      baseRendered: [...baseOutput(["hello"]), ac1, ac2],
      autocompleteCount: 2,
      width: 40,
      title: "anthropic/claude",
      theme: plainTheme(),
    });
    // The box's bottom border sits just above the autocomplete lines.
    const bottomIdx = lines.length - 3;
    expect(lines[bottomIdx].startsWith("╰")).toBe(true);
    expect(lines[bottomIdx + 1]).toBe(ac1);
    expect(lines[bottomIdx + 2]).toBe(ac2);
  });

  it("never exceeds the given width on any line", () => {
    const lines = renderEditorModalFrame({
      baseRendered: baseOutput(["a".repeat(80)]),
      autocompleteCount: 0,
      width: 40,
      title: "anthropic/claude-sonnet-4-6  high",
      theme: plainTheme(),
    });
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });

  it("uses the borderAccent color for the frame", () => {
    const fgMock = vi.fn((_c: string, t: string) => t);
    renderEditorModalFrame({
      baseRendered: baseOutput(["hello"]),
      autocompleteCount: 0,
      width: 40,
      title: "anthropic/claude",
      theme: { fg: fgMock },
    });
    expect(fgMock).toHaveBeenCalledWith("borderAccent", expect.any(String));
  });

  it("tints the frame with a custom border color when provided", () => {
    const fgMock = vi.fn((_c: string, t: string) => t);
    renderEditorModalFrame({
      baseRendered: baseOutput(["hello"]),
      autocompleteCount: 0,
      width: 40,
      title: "anthropic/claude",
      theme: { fg: fgMock },
      borderColor: "warning",
    });
    expect(fgMock).toHaveBeenCalledWith("warning", expect.any(String));
    expect(fgMock).not.toHaveBeenCalledWith("borderAccent", expect.any(String));
  });

  it("renders a right-aligned label in the top border", () => {
    const lines = renderEditorModalFrame({
      baseRendered: baseOutput(["hello"]),
      autocompleteCount: 0,
      width: 40,
      title: "anthropic/claude",
      titleRight: "⟦Plan Mode⟧",
      theme: plainTheme(),
    });
    expect(lines[0]).toContain("⟦Plan Mode⟧");
    expect(lines[0]).toContain("╭");
    expect(lines[0]).toContain("╮");
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });

  it("renders the title raw (pre-colored), not re-wrapped in accent", () => {
    const fgMock = vi.fn((c: string, t: string) => (c === "accent" ? `⟧${t}⟧` : t));
    const lines = renderEditorModalFrame({
      baseRendered: baseOutput(["hello"]),
      autocompleteCount: 0,
      width: 40,
      title: "anthropic/claude",
      theme: { fg: fgMock },
    });
    expect(lines[0]).toContain("anthropic/claude");
    expect(lines[0]).not.toContain("⟧");
  });

  it("falls back to truncated base output when width is too small to frame", () => {
    const base = baseOutput(["hello"], 10);
    const lines = renderEditorModalFrame({
      baseRendered: base,
      autocompleteCount: 0,
      width: 2,
      title: "anthropic/claude",
      theme: plainTheme(),
    });
    // Fallback: no frame added — same line count as the base, just truncated.
    expect(lines.length).toBe(base.length);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(2);
  });
});

// === Editor install lifecycle ===

describe("status-bar editor install", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    unconfigureSmallModel();
  });

  it("session_start installs a custom editor factory", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    expect(mockCtx.ui.setEditorComponent).toHaveBeenCalledWith(expect.any(Function));
  });

  it("session_shutdown restores the previous (default) editor", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const shutdownHandler = getEventHandler(mockPi, "session_shutdown");
    await shutdownHandler({ type: "session_shutdown", reason: "quit" }, mockCtx);

    // Default editor is restored (undefined = Pi's default).
    expect(mockCtx.ui.setEditorComponent).toHaveBeenLastCalledWith(undefined);
  });

  it("/statusbar:toggle disable restores the default editor and re-enable reinstalls", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("", mockCtx); // disable
    expect(mockCtx.ui.setEditorComponent).toHaveBeenLastCalledWith(undefined);

    await handler("", mockCtx); // re-enable
    expect(mockCtx.ui.setEditorComponent).toHaveBeenLastCalledWith(expect.any(Function));
  });

  it("preserves an outer editor behavior when enabled and disabled", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    const outerFactory = installEditorFactoryLayer(
      undefined,
      "test-outer-behavior",
      100,
      (parent, tui, theme, keybindings) => {
        const editor = (parent?.(tui, theme, keybindings) ?? {}) as { outer?: boolean };
        editor.outer = true;
        return editor;
      },
    );
    mockCtx.ui.setEditorComponent(outerFactory);
    mockCtx.ui.setEditorComponent.mockClear();

    await enableBar(mockPi, mockCtx);

    const installed = mockCtx.ui.getEditorComponent() as EditorFactory;
    expect(hasEditorFactoryLayer(installed, "status-bar")).toBe(true);
    expect(hasEditorFactoryLayer(installed, "test-outer-behavior")).toBe(true);
    expect((installed({}, {}, {}) as { outer?: boolean }).outer).toBe(true);

    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("", mockCtx);

    const restored = mockCtx.ui.getEditorComponent() as EditorFactory;
    expect(hasEditorFactoryLayer(restored, "status-bar")).toBe(false);
    expect(hasEditorFactoryLayer(restored, "test-outer-behavior")).toBe(true);
    expect((restored({}, {}, {}) as { outer?: boolean }).outer).toBe(true);
  });

  it("installs a factory marked as the status-bar editor (idempotent)", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const installed = mockCtx.ui.getEditorComponent();
    expect(typeof installed).toBe("function");
    // Re-firing session_start should not double-install: the current factory
    // is already ours, so setEditorComponent is not called again.
    mockCtx.ui.setEditorComponent.mockClear();
    const sessionStartHandler = getEventHandler(mockPi, "session_start");
    await sessionStartHandler({ type: "session_start", reason: "new" }, mockCtx);
    expect(mockCtx.ui.setEditorComponent).not.toHaveBeenCalled();
  });

  it("installed editor renders the model label on its metadata line", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    mockCtx.model = { id: "claude-sonnet-4-6", provider: "anthropic" } as any;
    await enableBar(mockPi, mockCtx);

    const editor = renderInstalledEditor(mockCtx);
    const lines = editor.render(80);

    expect(lines.some((l) => l.includes("anthropic/claude-sonnet-4-6"))).toBe(true);
  });

  it("installed editor renders the brain icon next to the thinking level", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockPi.getThinkingLevel = vi.fn(() => "high");
    await enableBar(mockPi, mockCtx);

    const editor = renderInstalledEditor(mockCtx);
    const lines = editor.render(80);
    const brain = String.fromCodePoint(0xf09d1);

    expect(lines.some((l) => l.includes(brain))).toBe(true);
    expect(lines.some((l) => l.includes("high"))).toBe(true);
  });

  it("installed editor shows no-model when no model is set", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.model = undefined;
    await enableBar(mockPi, mockCtx);

    const editor = renderInstalledEditor(mockCtx);
    const lines = editor.render(80);

    expect(lines.some((l) => l.includes("no-model"))).toBe(true);
    expect(lines.some((l) => l.includes("undefined/"))).toBe(false);
  });

  it("installed editor shows a model id alone when provider is absent", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    mockCtx.model = { id: "my-model", provider: undefined } as any;
    await enableBar(mockPi, mockCtx);

    const editor = renderInstalledEditor(mockCtx);
    const lines = editor.render(80);

    expect(lines.some((l) => l.includes("my-model"))).toBe(true);
    expect(lines.some((l) => l.includes("undefined/"))).toBe(false);
  });

  it("installed editor renders the small label after a slash separator", async () => {
    vi.mocked(loadSmallModelConfig).mockReturnValue({
      config: { provider: "synthetic", model: "haiku", thinkingLevel: "minimal" },
      source: "config",
    });
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    mockCtx.model = { id: "sonnet-4", provider: "anthropic" } as any;
    await enableBar(mockPi, mockCtx);

    const editor = renderInstalledEditor(mockCtx);
    const lines = editor.render(100);
    const metaLine = lines.find((l) => l.includes("synthetic/haiku")) ?? "";

    expect(metaLine).toContain("synthetic/haiku");
    // No prefix, no separate thinking level for the small model.
    expect(metaLine).not.toMatch(/\bsmall\b/);
    expect(metaLine).not.toContain("minimal");
    // Slash separator sits between the main model and the small label.
    const mainIdx = metaLine.indexOf("anthropic/sonnet-4");
    const slashIdx = metaLine.indexOf("  /  ");
    const smallIdx = metaLine.indexOf("synthetic/haiku");
    expect(mainIdx).toBeGreaterThan(-1);
    expect(slashIdx).toBeGreaterThan(mainIdx);
    expect(smallIdx).toBeGreaterThan(slashIdx);
    expect(loadSmallModelConfig).toHaveBeenCalled();
  });

  it("installed editor renders the small label grey with no italic", async () => {
    vi.mocked(loadSmallModelConfig).mockReturnValue({
      config: { provider: "synthetic", model: "haiku", thinkingLevel: "minimal" },
      source: "config",
    });
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    mockCtx.model = { id: "sonnet-4", provider: "anthropic" } as any;
    await enableBar(mockPi, mockCtx);

    const fgMock = vi.fn((_c: string, t: string) => t);
    const italicMock = vi.fn((t: string) => t);
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (mockCtx.ui as any).theme = { fg: fgMock, italic: italicMock };
    const editor = renderInstalledEditor(mockCtx);
    editor.render(100);

    expect(fgMock).toHaveBeenCalledWith("dim", "/");
    expect(fgMock).toHaveBeenCalledWith("dim", "synthetic/haiku");
    expect(italicMock).not.toHaveBeenCalled();
  });

  it("installed editor omits the slash and small label when none is configured", async () => {
    // Default mock throws → label cleared.
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    mockCtx.model = { id: "sonnet-4", provider: "anthropic" } as any;
    await enableBar(mockPi, mockCtx);

    const editor = renderInstalledEditor(mockCtx);
    const lines = editor.render(100);
    const metaLine = lines.find((l) => l.includes("anthropic/sonnet-4")) ?? "";

    expect(metaLine).not.toContain("haiku");
    expect(metaLine).not.toContain("  /  ");
  });

  it("turn_start refreshes the small model label", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    mockCtx.model = { id: "sonnet-4", provider: "anthropic" } as any;
    await enableBar(mockPi, mockCtx);

    let editor = renderInstalledEditor(mockCtx);
    expect(editor.render(100).some((l) => l.includes("synthetic/haiku"))).toBe(false);

    vi.mocked(loadSmallModelConfig).mockReturnValue({
      config: { provider: "synthetic", model: "haiku", thinkingLevel: "minimal" },
      source: "config",
    });
    const turnStartHandler = getEventHandler(mockPi, "turn_start");
    await turnStartHandler({ type: "turn_start", turnIndex: 0, timestamp: Date.now() }, mockCtx);

    editor = renderInstalledEditor(mockCtx);
    expect(editor.render(100).some((l) => l.includes("synthetic/haiku"))).toBe(true);
  });
});

/** Invoke the installed editor factory and return the editor instance. */
function renderInstalledEditor(mockCtx: ReturnType<typeof createMockCommandContext>) {
  const factory = mockCtx.ui.getEditorComponent();
  if (typeof factory !== "function") throw new Error("No editor factory installed");
  const editor = factory({ requestRender() {} }, {}, {});
  return editor as { render(width: number): string[] };
}

/**
 * Extract the Neuralwatt flex-state handler the status-bar registered on
 * pi.events. Returns undefined if the status-bar never subscribed (the
 * neuralwatt extension populates the real state; tests drive it directly).
 */
function getFlexHandler(mockPi: ReturnType<typeof createMockPi>) {
  const calls = (mockPi.events.on as ReturnType<typeof vi.fn>).mock.calls;
  for (const [event, handler] of calls) {
    if (event === "neuralwatt:flex-change") {
      return handler as (flex: { flexOn: boolean; flexCapable: boolean }) => void;
    }
  }
  return undefined;
}

/**
 * Extract the plan-mode handler the status-bar registered on pi.events. The
 * plan extension populates the real state; tests drive it directly.
 */
function getPlanModeHandler(mockPi: ReturnType<typeof createMockPi>) {
  const calls = (mockPi.events.on as ReturnType<typeof vi.fn>).mock.calls;
  for (const [event, handler] of calls) {
    if (event === "plan:mode-change") {
      return handler as (payload: { mode: string }) => void;
    }
  }
  return undefined;
}

/**
 * Extract the goal-state handler the status-bar registered on pi.events at
 * load time. The goal extension populates the real state; tests drive it
 * directly.
 */
function getGoalHandler(mockPi: ReturnType<typeof createMockPi>) {
  const calls = (mockPi.events.on as ReturnType<typeof vi.fn>).mock.calls;
  for (const [event, handler] of calls) {
    if (event === "goal:state-change") {
      return handler as (payload: {
        status: string | null;
        iteration?: number;
        maxIterations?: number;
      }) => void;
    }
  }
  return undefined;
}

describe("status-bar goal badge", () => {
  it("installed editor shows a Goal badge while a goal is running", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const handler = getGoalHandler(mockPi);
    expect(handler).toBeDefined();
    handler?.({ status: "active" });

    const editor = renderInstalledEditor(mockCtx);
    const lines = editor.render(100);
    expect(lines[0]).toContain("Goal");
  });

  it("hides the badge when the goal is paused, complete, or gone", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const handler = getGoalHandler(mockPi);
    handler?.({ status: "active" });
    handler?.({ status: "paused" });

    const editor = renderInstalledEditor(mockCtx);
    expect(editor.render(100).some((l) => l.includes("Goal"))).toBe(false);

    handler?.({ status: "active" });
    handler?.({ status: "complete" });
    expect(editor.render(100).some((l) => l.includes("Goal"))).toBe(false);

    handler?.({ status: "active" });
    handler?.({ status: null });
    expect(editor.render(100).some((l) => l.includes("Goal"))).toBe(false);
  });

  it("shows the iteration count and cap in the Goal badge", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    getGoalHandler(mockPi)?.({ status: "active", iteration: 3, maxIterations: 25 });

    const editor = renderInstalledEditor(mockCtx);
    expect(editor.render(100)[0]).toContain("Goal 3/25");
  });

  it("shows the iteration count without a cap for unlimited goals", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    getGoalHandler(mockPi)?.({ status: "active", iteration: 4, maxIterations: 0 });

    const editor = renderInstalledEditor(mockCtx);
    const topLine = editor.render(100)[0] ?? "";
    expect(topLine).toContain("Goal 4");
    expect(topLine).not.toContain("Goal 4/");
  });

  it("shows the Goal badge beside Plan Mode when both are active", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    getPlanModeHandler(mockPi)?.({ mode: "plan" });
    getGoalHandler(mockPi)?.({ status: "active", iteration: 2, maxIterations: 25 });

    const editor = renderInstalledEditor(mockCtx);
    const topLine = editor.render(120)[0] ?? "";
    expect(topLine).toContain("Plan Mode");
    expect(topLine).toContain("Goal");
  });

  it("status-bar subscribes to goal:state-change at load time (before session_start)", async () => {
    const mockPi = createMockPi();
    await statusBarExtension(mockPi);
    // No session_start required: the subscription must exist as soon as the
    // extension loads, or the first-load goal announcement is missed.
    expect(getGoalHandler(mockPi)).toBeDefined();
  });

  it("footer line 2 suppresses the goal status (a running goal is the badge)", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData({
        statuses: new Map([["goal", "🎯 Goal: active 2m 30s"]]),
      }),
    );
    const lines = component.render(120);

    expect(lines.length).toBe(1);
    expect(lines[0]).not.toContain("Goal");
  });
});

describe("status-bar flex badge", () => {
  function plainTheme() {
    return { fg: vi.fn((_color: string, text: string) => text) };
  }

  it("buildEditorMetaSegments appends a flex-on badge when capable and on", () => {
    const segments = buildEditorMetaSegments(
      "neuralwatt/glm-5.2",
      "high",
      {
        on: true,
        capable: true,
      },
      "",
      plainTheme(),
    );
    expect(segments.some((s) => s.includes("flex"))).toBe(true);
    expect(segments.some((s) => s.includes("on"))).toBe(true);
  });

  it("buildEditorMetaSegments appends a flex-off badge when capable and off", () => {
    const segments = buildEditorMetaSegments(
      "neuralwatt/glm-5.2",
      "high",
      {
        on: false,
        capable: true,
      },
      "",
      plainTheme(),
    );
    expect(segments.some((s) => s.includes("flex"))).toBe(true);
    expect(segments.some((s) => s.includes("off"))).toBe(true);
  });

  it("buildEditorMetaSegments omits the flex badge when the model is not flex-capable", () => {
    const segments = buildEditorMetaSegments(
      "anthropic/claude-sonnet-4-6",
      "high",
      { on: true, capable: false },
      "",
      plainTheme(),
    );
    expect(segments.some((s) => s.includes("flex"))).toBe(false);
  });

  it("installed editor renders the flex badge after a neuralwatt:flex-change event", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const flexHandler = getFlexHandler(mockPi);
    expect(flexHandler).toBeDefined();

    flexHandler?.({ flexOn: true, flexCapable: true });

    const editor = renderInstalledEditor(mockCtx);
    const lines = editor.render(100);
    const metaLine = lines.find((l) => l.includes("flex")) ?? "";
    expect(metaLine).toContain("⚡");
    expect(metaLine).toContain("on");
  });

  it("installed editor hides the flex badge when flexCapable is false", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const flexHandler = getFlexHandler(mockPi);
    flexHandler?.({ flexOn: false, flexCapable: false });

    const editor = renderInstalledEditor(mockCtx);
    const lines = editor.render(100);
    expect(lines.some((l) => l.includes("flex"))).toBe(false);
  });

  it("status-bar subscribes to neuralwatt:flex-change on session_start", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);
    expect(getFlexHandler(mockPi)).toBeDefined();
  });
});

describe("status-bar plan mode tint", () => {
  it("installed editor tints the frame while plan mode is active", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const planHandler = getPlanModeHandler(mockPi);
    expect(planHandler).toBeDefined();
    planHandler?.({ mode: "plan" });

    const editor = renderInstalledEditor(mockCtx);
    const lines = editor.render(100);
    expect(lines[0]).toContain("Plan Mode");
    expect(mockCtx.ui.theme.fg).toHaveBeenCalledWith("warning", expect.any(String));
  });

  it("installed editor keeps the default frame color when not planning", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const planHandler = getPlanModeHandler(mockPi);
    planHandler?.({ mode: "executing" });

    const editor = renderInstalledEditor(mockCtx);
    const lines = editor.render(100);
    expect(lines.some((l) => l.includes("Plan Mode"))).toBe(false);
    expect(mockCtx.ui.theme.fg).toHaveBeenCalledWith("borderAccent", expect.any(String));
    expect(mockCtx.ui.theme.fg).not.toHaveBeenCalledWith("warning", expect.any(String));
  });

  it("status-bar subscribes to plan:mode-change on session_start", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);
    expect(getPlanModeHandler(mockPi)).toBeDefined();
  });
});

describe("status-bar small model segment", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    unconfigureSmallModel();
  });

  function plainTheme() {
    return { fg: vi.fn((_color: string, text: string) => text) };
  }

  it("buildEditorMetaSegments lays out main group, slash, then small label", () => {
    const segments = buildEditorMetaSegments(
      "anthropic/sonnet-4",
      "high",
      { on: false, capable: false },
      "synthetic/haiku",
      plainTheme(),
    );

    // Order: main model, main thinking, slash, small label.
    const mainIdx = segments.findIndex((s) => s.includes("anthropic/sonnet-4"));
    const thinkingIdx = segments.findIndex((s) => /\bhigh\b/.test(s));
    const slashIdx = segments.findIndex((s) => s.trim() === "/");
    const smallIdx = segments.findIndex((s) => s.includes("synthetic/haiku"));
    expect(mainIdx).toBeGreaterThanOrEqual(0);
    expect(thinkingIdx).toBe(mainIdx + 1);
    expect(slashIdx).toBe(thinkingIdx + 1);
    expect(smallIdx).toBe(slashIdx + 1);
    // No separate thinking level for the small model.
    expect(segments.length).toBe(smallIdx + 1);
  });

  it("renders the small label grey with a dim slash, no prefix or italic", () => {
    const fgMock = vi.fn((_color: string, text: string) => text);
    const italicMock = vi.fn((text: string) => text);
    buildEditorMetaSegments(
      "anthropic/sonnet-4",
      "high",
      { on: false, capable: false },
      "synthetic/haiku",
      { fg: fgMock, italic: italicMock },
    );

    expect(fgMock).toHaveBeenCalledWith("dim", "/");
    expect(fgMock).toHaveBeenCalledWith("dim", "synthetic/haiku");
    // No "small" prefix and no italicization.
    expect(fgMock).not.toHaveBeenCalledWith("dim", expect.stringContaining("small "));
    expect(italicMock).not.toHaveBeenCalled();
  });

  it("the main model label stays accent (not grey)", () => {
    const fgMock = vi.fn((_color: string, text: string) => text);
    buildEditorMetaSegments(
      "anthropic/sonnet-4",
      "high",
      { on: false, capable: false },
      "synthetic/haiku",
      { fg: fgMock, italic: vi.fn((t: string) => t) },
    );
    expect(fgMock).toHaveBeenCalledWith("accent", "anthropic/sonnet-4");
  });

  it("buildEditorMetaSegments omits the slash and small label when unconfigured", () => {
    const segments = buildEditorMetaSegments(
      "anthropic/sonnet-4",
      "high",
      { on: false, capable: false },
      "",
      plainTheme(),
    );
    expect(segments.some((s) => s.includes("synthetic/haiku"))).toBe(false);
    expect(segments.some((s) => s.trim() === "/")).toBe(false);
    // Main model and thinking level remain.
    expect(segments.some((s) => s.includes("anthropic/sonnet-4"))).toBe(true);
    expect(segments.some((s) => /\bhigh\b/.test(s))).toBe(true);
  });

  it("footer line 2 suppresses the small-model status even alongside other statuses", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData({
        statuses: new Map([
          ["small-model", "small synthetic/haiku · minimal"],
          ["neuralwatt", "🎯 active"],
        ]),
      }),
    );
    const lines = component.render(120);

    // Line 2 still renders for the neuralwatt status, but small-model is gone.
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("🎯 active");
    expect(lines[1]).not.toContain("small synthetic/haiku");
  });

  it("updates the small model label immediately when the config file changes", async () => {
    // Point the watcher at a real temp file so fs.watch fires on write.
    const tmp = await mkdtemp(join(tmpdir(), "status-bar-small-model-"));
    const configPath = join(tmp, "small-model.json");
    await writeFile(configPath, "{}");
    vi.mocked(resolveSmallModelConfigPath).mockReturnValue(configPath);

    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    mockCtx.model = { id: "sonnet-4", provider: "anthropic" } as any;
    await enableBar(mockPi, mockCtx);

    // Initially unconfigured → no small label in the title.
    expect(
      renderInstalledEditor(mockCtx)
        .render(100)
        .some((l) => l.includes("synthetic/haiku")),
    ).toBe(false);

    // Select a small model and touch the config file to fire the watcher.
    vi.mocked(loadSmallModelConfig).mockReturnValue({
      config: { provider: "synthetic", model: "haiku", thinkingLevel: "minimal" },
      source: "config",
    });
    await writeFile(configPath, '{"changed":true}');

    await vi.waitFor(() => {
      expect(
        renderInstalledEditor(mockCtx)
          .render(100)
          .some((l) => l.includes("synthetic/haiku")),
      ).toBe(true);
    });
  });
});
