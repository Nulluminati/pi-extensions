import { type FSWatcher, watch } from "node:fs";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import statusBarExtension, {
  buildEditorMetaSegments,
  ICON_SMALL_MODEL,
  ICON_WORKER_MODEL,
  renderEditorModalFrame,
  STATUS_ICON,
} from "../../extensions/status-bar/status-bar.ts";
import {
  type EditorFactory,
  hasEditorFactoryLayer,
  installEditorFactoryLayer,
} from "../../lib/editor-factory.ts";
import { loadSmallModelConfig, resolveSmallModelConfigPath } from "../../lib/small-model.ts";
import { loadWorkerModelConfig } from "../../lib/worker-model.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { getEventHandler } from "../mocks/test-helpers.ts";

// watch is wrapped (not replaced) so tests can grab the live FSWatcher
// handle while every other test keeps real watch behavior.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, watch: vi.fn(actual.watch) };
});

vi.mock("../../lib/small-model.ts", () => ({
  loadSmallModelConfig: vi.fn(),
  resolveSmallModelConfigPath: vi.fn(() => "/agent/small-model.json"),
}));

vi.mock("../../lib/worker-model.ts", () => ({
  loadWorkerModelConfig: vi.fn(),
  resolveWorkerModelConfigPath: vi.fn(() => "/agent/worker-model.json"),
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

function unconfigureWorkerModel(): void {
  vi.mocked(loadWorkerModelConfig).mockImplementation(() => {
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
  return call[1] as (payload: unknown) => void;
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
    unconfigureWorkerModel();
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

    expect(lines.join("\n")).not.toContain("anthropic/claude-sonnet-4-6");
    expect(lines.join("\n")).toContain("main");
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

    expect(lines.join("\n")).not.toContain("openai/gpt-4o");
  });

  it("footer omits the worker model because it lives in the editor box", async () => {
    vi.mocked(loadWorkerModelConfig).mockReturnValue({
      config: { provider: "opencode-go", model: "deepseek-flash", thinkingLevel: "high" },
      source: "config",
    });
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData({ branch: "main" }),
    );
    const lines = component.render(120);

    expect(lines.join("\n")).not.toContain("via");
    expect(lines.join("\n")).not.toContain("opencode-go/deepseek-flash");
    expect(lines.join("\n")).toContain("main");
  });

  it("editor box keeps the configured worker model", async () => {
    vi.mocked(loadWorkerModelConfig).mockReturnValue({
      config: { provider: "opencode-go", model: "deepseek-flash", thinkingLevel: "high" },
      source: "config",
    });
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const lines = renderInstalledEditor(mockCtx).render(120);

    expect(lines.some((line) => line.includes("opencode-go/deepseek-flash"))).toBe(true);
  });

  it("footer shows the working directory basename", async () => {
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

    expect(lines.join("\n")).toContain("my-app");
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
    expect(lines.join("\n")).toContain(folder);
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
    expect(lines.join("\n")).toContain(git);
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

    expect(lines.join("\n")).toContain("50.0k/200.0k");
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
    expect(lines.join("\n")).toContain("262.0k/200.0k");
    // Bar is fully filled (10 blocks) rather than crashing.
    expect(lines.join("\n")).toContain("[██████████]");
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
    expect(component.render(120).join("\n")).toContain("50.0k/200.0k");
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
    expect(component.render(120).join("\n")).toContain("1.0k/200.0k");

    // A new assistant message grows the context; the cache must refresh.
    mockCtx.getContextUsage = vi.fn(() => ({
      tokens: 80000,
      contextWindow: 200000,
      percent: 40,
    }));
    const messageEnd = getEventHandler(mockPi, "message_end");
    await messageEnd({ type: "message_end", message: { role: "assistant" } }, mockCtx);

    expect(component.render(120).join("\n")).toContain("80.0k/200.0k");
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

    expect(lines.join("\n")).toContain("↻1");
  });

  it("turn count lives in the Session panel, right of Context", async () => {
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
    const sessionColumn = lines[0].indexOf("Session") - 3;
    expect(sessionColumn).toBeGreaterThan(lines[0].indexOf("Context"));
    expect(lines[1].slice(sessionColumn)).toContain("↻1");
    expect(lines.join("\n")).toContain("↑1.0k");
  });

  it("turn_end accumulates token usage in the footer", async () => {
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

    expect(lines.join("\n")).toContain("↑1.0k");
    expect(lines.join("\n")).toContain("↓500");
    expect(lines.join("\n")).toContain("↗200");
    expect(lines.join("\n")).toContain("↘100");
    expect(lines.join("\n")).toContain("$0.030");
  });

  it("turn_end counts toolResult roll-ups, standalone usage, compaction, and branch summary", async () => {
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
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
        },
      },
      {
        // Codemode nested LLM calls (image, classifier, nested tools) roll
        // their usage into the top-level toolResult.
        type: "message",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "ok" }],
          toolName: "bash",
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } },
        },
      },
      {
        type: "usage",
        usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
      },
      {
        type: "compaction",
        usage: { input: 20, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.002 } },
      },
      {
        type: "branch_summary",
        usage: { input: 30, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.004 } },
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

    // Every entry counted exactly once: 100+100+10+20+30 in, 50+50 out.
    expect(lines.join("\n")).toContain("↑260");
    expect(lines.join("\n")).toContain("↓100");
    expect(lines.join("\n")).toContain("$1.017");
  });

  it("does not recount nested codemode usage already rolled into the toolResult", async () => {
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
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "ok" }],
          toolName: "bash",
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } },
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

    expect(lines.join("\n")).toContain("↑110");
    expect(lines.join("\n")).toContain("↓55");
    expect(lines.join("\n")).toContain("$1.010");
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

    expect(lines.join("\n")).toContain("↑3.0k");
    expect(lines.join("\n")).toContain("↓1.5k");
    expect(lines.join("\n")).toContain("↗500");
    expect(lines.join("\n")).toContain("↘100");
    expect(lines.join("\n")).toContain("$0.050");
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

    expect(lines.join("\n")).toContain("↑1.0k");
    expect(lines.join("\n")).toContain("↓500");
    expect(lines.join("\n")).toContain("↗0");
    expect(lines.join("\n")).toContain("↘0");
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

    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).toContain("↑0");
    expect(lines.join("\n")).toContain("↓0");
    expect(lines.join("\n")).toContain("↗0");
    expect(lines.join("\n")).toContain("↘0");
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

    expect(lines.join("\n")).toContain("$0.000");
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

    expect(lines.join("\n")).toContain("$0.012");
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

    expect(lines.join("\n")).toContain("↑500");
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

    expect(lines.join("\n")).toContain("main");
    expect(lines.join("\n")).not.toContain("[");
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

    expect(lines.join("\n")).toContain("[");
    expect(lines.join("\n")).toContain("!");
    expect(lines.join("\n")).toContain("+");
    expect(lines.join("\n")).toContain("?");
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

    expect(lines.join("\n")).toContain("↑");
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

    expect(lines.join("\n")).toContain("↓");
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

    expect(lines.join("\n")).toContain("⇕");
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

    expect(lines.join("\n")).toContain("$");
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

    expect(lines.join("\n")).toContain("=");
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
    expect(lines.join("\n")).not.toContain("[");
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

  // --- Panel layout ---

  it("renders framed panels beside each other when their content fits", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.getContextUsage = vi.fn(() => ({ tokens: 50000, contextWindow: 200000, percent: 25 }));
    await enableBar(mockPi, mockCtx);
    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData({ branch: "main" }),
    );
    const lines = component.render(160);
    expect(lines[0]).toContain("Workspace");
    expect(lines[0]).toContain("Context");
    expect(lines[0]).toContain("Session");
    expect(lines[0].match(/╭/g)).toHaveLength(3);
    expect(lines.join("\n")).toContain("50.0k/200.0k");
    expect(lines.at(-1)?.match(/╰/g)).toHaveLength(3);
  });

  it("shares unused terminal width across all three panels", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);
    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData({ branch: "main" }),
    );
    for (const width of [160, 161, 162, 163]) {
      const lines = component.render(width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
    }
    const panelWidths = (width: number) =>
      (component.render(width)[0].match(/╭[^╮]*╮/gu) ?? []).map(visibleWidth);
    const before = panelWidths(160);
    const after = panelWidths(163);
    expect(before).toHaveLength(3);
    expect(after).toEqual(before.map((width: number) => width + 1));
  });

  it("stacks panels on narrow terminals without shedding metrics", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.getContextUsage = vi.fn(() => ({ tokens: 50000, contextWindow: 200000, percent: 25 }));
    await enableBar(mockPi, mockCtx);
    getEventsHandler(mockPi, "messenger:state")({ name: "scout", unread: 3 });
    getEventsHandler(
      mockPi,
      "workers:state",
    )({ running: 1, workerCostUsd: 0.041, workerTokens: 38100 });
    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData({ branch: "main" }),
    );
    const lines = component.render(40);
    const text = lines.join("\n");
    expect(lines.filter((line: string) => line.includes("╭"))).toHaveLength(3);
    for (const value of [
      "Workspace",
      "Context",
      "Session",
      "main",
      "50.0k/200.0k",
      "↑0",
      "↓0",
      "↗0",
      "↘0",
      "↻0",
      "$0.000",
      "✉ 3",
      "⚙ $0.04",
      "38.1k",
    ]) {
      expect(text).toContain(value);
    }
    for (let width = 0; width <= 160; width++) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line), `width ${width}`).toBeLessThanOrEqual(width);
      }
    }
  });

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

  it("renders only panels when there are no transient events", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData({ statuses: new Map() }),
    );
    const lines = component.render(120);

    expect(lines).toHaveLength(3);
    expect(lines.at(-1)).toContain("╰");
  });

  it("renders extension statuses after the panels", async () => {
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

    expect(lines).toHaveLength(5);
    expect(lines[3]).toContain("🎯 active");
    // The small model lives in the editor meta line, so it is suppressed here.
    expect(lines.at(-1)).not.toContain("small synthetic/syn:small:text · minimal");
    expect(lines.at(-1)).toContain("some status");
    // Model lives in the editor box, not the footer.
    expect(lines.join("\n")).not.toContain("test-model");
  });

  it("does not show its own status-bar status below the panels", async () => {
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

    expect(lines.at(-1)).not.toContain(`${STATUS_ICON} statusbar`);
    expect(lines.at(-1)).toContain("🎯 active");
  });

  it("suppresses missions, messenger, autoresearch, workers, and background-jobs fallback statuses", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData({
        statuses: new Map([
          ["missions", "◆ mission fix-bug · running 4m"],
          ["messenger", "✉ Messenger: 3 unread · scout"],
          ["autoresearch", "⌕ researching auth flows"],
          ["workers", "⚙ Workers: 1 running · $0.04"],
          ["background-jobs", "▣ Jobs: 1 job: #1 npm"],
          ["some-other-ext", "foreign status"],
        ]),
      }),
    );
    const lines = component.render(120);

    // The foreign status still renders below the panels, but widget-first
    // extensions are suppressed (their setStatus entries are default-footer
    // fallbacks and would double-render).
    expect(lines).toHaveLength(4);
    expect(lines.at(-1)).toContain("foreign status");
    expect(lines.at(-1)).not.toContain("mission fix-bug");
    expect(lines.at(-1)).not.toContain("Messenger");
    expect(lines.at(-1)).not.toContain("✉");
    expect(lines.at(-1)).not.toContain("researching auth flows");
    expect(lines.at(-1)).not.toContain("running · $0.04");
    expect(lines.at(-1)).not.toContain("Jobs: 1 job");
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
    expect(lines.join("\n")).not.toContain("test-model");
    expect(lines.join("\n")).not.toContain("50.0k");
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

    expect(lines.join("\n")).not.toContain("no-model");
    expect(lines.join("\n")).not.toContain("undefined/");
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

    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).toContain("↻0");
    expect(lines.join("\n")).toContain("↑0 ↓0 ↗0 ↘0");
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

    expect(lines.join("\n")).not.toContain("my-model");
    expect(lines.join("\n")).not.toContain("undefined/");
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
      titleRight: "⟦Review off⟧",
      theme: plainTheme(),
    });
    expect(lines[0]).toContain("⟦Review off⟧");
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

  it("session reload replaces the editor layer with a factory bound to the new extension instance", async () => {
    const firstPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.model = {
      ...mockCtx.model,
      id: "old-model",
      // biome-ignore lint/suspicious/noExplicitAny: test mock
    } as any;
    await enableBar(firstPi, mockCtx);

    const shutdownHandler = getEventHandler(firstPi, "session_shutdown");
    await shutdownHandler({ type: "session_shutdown", reason: "reload" }, mockCtx);
    expect(hasEditorFactoryLayer(mockCtx.ui.getEditorComponent(), "status-bar")).toBe(false);

    const reboundPi = createMockPi();
    mockCtx.model = {
      ...mockCtx.model,
      id: "rebound-model",
      // biome-ignore lint/suspicious/noExplicitAny: test mock
    } as any;
    await statusBarExtension(reboundPi);
    await getEventHandler(reboundPi, "session_start")(
      { type: "session_start", reason: "reload" },
      mockCtx,
    );

    const lines = renderInstalledEditor(mockCtx).render(100);
    expect(lines.some((line) => line.includes("rebound-model"))).toBe(true);
    expect(lines.some((line) => line.includes("old-model"))).toBe(false);
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
    expect(fgMock).toHaveBeenCalledWith("dim", expect.stringContaining("synthetic/haiku"));
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
 * Extract the approval-state handler the status-bar registered on pi.events.
 * The approval extension populates the real state; tests drive it directly.
 */
function getApprovalHandler(mockPi: ReturnType<typeof createMockPi>) {
  const calls = (mockPi.events.on as ReturnType<typeof vi.fn>).mock.calls;
  for (const [event, handler] of calls) {
    if (event === "approval-mode:state") {
      return handler as (payload: { enabled: boolean }) => void;
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

  it("shows the Goal badge beside Approval Mode off", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    getApprovalHandler(mockPi)?.({ enabled: false });
    getGoalHandler(mockPi)?.({ status: "active", iteration: 2, maxIterations: 25 });

    const editor = renderInstalledEditor(mockCtx);
    const topLine = editor.render(120)[0] ?? "";
    expect(topLine).toContain("Approval Mode off");
    expect(topLine).toContain("Goal");
  });

  it("status-bar subscribes to goal:state-change at load time (before session_start)", async () => {
    const mockPi = createMockPi();
    await statusBarExtension(mockPi);
    // No session_start required: the subscription must exist as soon as the
    // extension loads, or the first-load goal announcement is missed.
    expect(getGoalHandler(mockPi)).toBeDefined();
  });

  it("suppresses the goal fallback status (a running goal is the badge)", async () => {
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

    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).not.toContain("Goal");
  });
});

describe("status-bar mail slot", () => {
  function plainTheme() {
    return { fg: vi.fn((_color: string, text: string) => text) };
  }

  /** Enable the bar with context, token history, one turn, and unread mail
   * so the Context and Session panels contain all their indicators. */
  async function enableBarWithMail(
    mockPi: ReturnType<typeof createMockPi>,
    mockCtx: ReturnType<typeof createMockCommandContext>,
  ) {
    mockCtx.getContextUsage = vi.fn(() => ({
      tokens: 50000,
      contextWindow: 200000,
      percent: 25,
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
    const turnStartHandler = getEventHandler(mockPi, "turn_start");
    await turnStartHandler({ type: "turn_start", turnIndex: 0, timestamp: Date.now() }, mockCtx);
    getEventsHandler(mockPi, "messenger:state")({ name: "scout", unread: 2 });
  }

  it("status-bar subscribes to messenger:state at load time (before session_start)", async () => {
    const mockPi = createMockPi();
    await statusBarExtension(mockPi);
    // No session_start required: the messenger extension publishes its state
    // during its own session_start handler, which may run before this
    // extension's session_start-scoped listeners exist.
    expect(getEventsHandler(mockPi, "messenger:state")).toBeDefined();
  });

  it("messenger:state with unread 2 shows ✉ 2 in the footer", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBarWithMail(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    const lines = component.render(120);
    const sessionColumn = lines[0].indexOf("Session") - 3;
    expect(lines[2].slice(sessionColumn)).toContain("✉ 2");
  });

  it("mail segment renders in the success color", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBarWithMail(mockPi, mockCtx);

    const fgMock = vi.fn((_color: string, text: string) => text);
    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      { fg: fgMock },
      footerData(),
    );
    component.render(120);

    expect(fgMock).toHaveBeenCalledWith("success", "✉ 2");
  });

  it("messenger:state with unread 0 clears the mail segment", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBarWithMail(mockPi, mockCtx);

    getEventsHandler(mockPi, "messenger:state")({ name: "scout", unread: 0 });

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    expect(component.render(120).join("\n")).not.toContain("✉");
  });

  it("no mail segment and no gap artifacts at unread 0", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    const line = component.render(120).join("\n");

    expect(line).not.toContain("✉");
    expect(line).not.toContain("✉ 0");
    expect(line).toContain("$0.000");
    expect(component.render(120).at(-1)).toContain("╰");
  });

  it("messenger:state triggers a footer re-render", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const requestRender = vi.fn();
    getFooterFactory(mockCtx)({ requestRender }, plainTheme(), footerData());

    getEventsHandler(mockPi, "messenger:state")({ name: "scout", unread: 1 });
    expect(requestRender).toHaveBeenCalled();
  });

  it("retains mail, cost, turns, and token counts as panels stack", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBarWithMail(mockPi, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );

    for (let width = 24; width <= 140; width++) {
      const text = component.render(width).join("\n");
      for (const value of ["✉ 2", "↻1", "$0.030", "↑1.0k", "↓500", "↗200", "↘100", "█"]) {
        expect(text, `width ${width}`).toContain(value);
      }
    }
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

  it("buildEditorMetaSegments renders the worker model next to the small model", () => {
    const segments = buildEditorMetaSegments(
      "synthetic/hf:zai-org/GLM-5.3-Flash",
      "high",
      { on: true, capable: true },
      "synthetic/syn:small:text",
      plainTheme(),
      "opencode-go/glm-5.3-flash",
    );
    const smallIndex = segments.findIndex((s) => s.includes("syn:small:text"));
    const workerIndex = segments.findIndex((s) => s.includes("glm-5.3-flash"));
    expect(smallIndex).toBeGreaterThanOrEqual(0);
    expect(workerIndex).toBe(smallIndex + 2);
    // The "/" separator sits between the two secondary labels.
    expect(segments[smallIndex + 1]).toBe("/");
    // Each secondary label carries its own distinguishing icon.
    expect(segments[smallIndex].startsWith(ICON_SMALL_MODEL)).toBe(true);
    expect(segments[workerIndex].startsWith(ICON_WORKER_MODEL)).toBe(true);
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

  it("prompt history survives editor recreation only within the same session", async () => {
    const { PolishedEditor } = await import("../../extensions/status-bar/src/editor.ts");
    const theme = { fg: vi.fn((_c: string, t: string) => t) };
    const tui = { requestRender: vi.fn() };
    const makeEditor = (sessionId: string) =>
      new PolishedEditor(
        tui,
        theme,
        {},
        theme,
        () => "main",
        () => "",
        () => "none",
        () => ({ on: false, capable: false }),
        () => undefined,
        () => undefined,
        undefined,
        sessionId,
      );

    const first = makeEditor("history-session-a");
    first.addToHistory("prompt before reload");

    const reloaded = makeEditor("history-session-a");
    const reloadedHistory = (reloaded as unknown as { history: string[] }).history;
    expect(reloadedHistory).toContain("prompt before reload");

    const unrelated = makeEditor("history-session-b");
    const unrelatedHistory = (unrelated as unknown as { history: string[] }).history;
    expect(unrelatedHistory).not.toContain("prompt before reload");
  });

  it("bounds prompt history across sessions without losing the current session", async () => {
    const { PolishedEditor } = await import("../../extensions/status-bar/src/editor.ts");
    const theme = { fg: vi.fn((_c: string, text: string) => text) };
    const makeEditor = (sessionId: string) =>
      new PolishedEditor(
        { requestRender: vi.fn() },
        theme,
        {},
        theme,
        () => "main",
        () => "",
        () => "none",
        () => ({ on: false, capable: false }),
        () => undefined,
        () => undefined,
        undefined,
        sessionId,
      );

    makeEditor("history-bound-0").addToHistory("old prompt");
    for (let index = 1; index <= 32; index++) {
      makeEditor(`history-bound-${index}`).addToHistory(`prompt ${index}`);
    }

    const oldest = makeEditor("history-bound-0") as unknown as { history: string[] };
    const latest = makeEditor("history-bound-32") as unknown as { history: string[] };
    expect(oldest.history).not.toContain("old prompt");
    expect(latest.history).toContain("prompt 32");
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

  it("status-bar subscribes to neuralwatt:flex-change at load time (before session_start)", async () => {
    const mockPi = createMockPi();
    await statusBarExtension(mockPi);
    // No session_start required: the neuralwatt extension emits flex state
    // during its own session_start handler, which may run before this
    // extension's session_start-scoped listeners exist.
    expect(getFlexHandler(mockPi)).toBeDefined();
  });

  it("keeps one neuralwatt:flex-change subscription across repeated session_start", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await statusBarExtension(mockPi);

    // pi.events.on records every subscription; the flex subscription must be
    // registered once at load time, not stacked again on each session start.
    const flexSubscriptionCount = () =>
      (mockPi.events.on as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => c[0] === "neuralwatt:flex-change",
      ).length;

    const sessionStartHandler = getEventHandler(mockPi, "session_start");
    await sessionStartHandler({ type: "session_start", reason: "new" }, mockCtx);
    await sessionStartHandler({ type: "session_start", reason: "new" }, mockCtx);

    expect(flexSubscriptionCount()).toBe(1);
  });
});

describe("status-bar approval indicator", () => {
  it("shows a warning badge when main-session Jev review is off", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const handler = getApprovalHandler(mockPi);
    expect(handler).toBeDefined();
    handler?.({ enabled: false });

    const editor = renderInstalledEditor(mockCtx);
    expect(editor.render(100)[0]).toContain("Approval Mode off");
    expect(mockCtx.ui.theme.fg).toHaveBeenCalledWith("warning", expect.any(String));
  });

  it("hides the badge and keeps the default frame when review is on", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const handler = getApprovalHandler(mockPi);
    handler?.({ enabled: false });
    handler?.({ enabled: true });

    const editor = renderInstalledEditor(mockCtx);
    expect(editor.render(100).some((line) => line.includes("Approval Mode off"))).toBe(false);
    expect(mockCtx.ui.theme.fg).toHaveBeenCalledWith("borderAccent", expect.any(String));
  });

  it("subscribes to approval-mode:state before session_start", async () => {
    const mockPi = createMockPi();
    await statusBarExtension(mockPi);
    expect(getApprovalHandler(mockPi)).toBeDefined();
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

  it("renders the small label grey with a dim slash and icon prefix, no italic", () => {
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
    expect(fgMock).toHaveBeenCalledWith("dim", expect.stringContaining("synthetic/haiku"));
    // The small-model icon prefixes the label; no italicization.
    expect(fgMock).toHaveBeenCalledWith(
      "dim",
      expect.stringContaining(String.fromCodePoint(0xf09df)),
    );
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

  it("suppresses the small-model fallback alongside other statuses", async () => {
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

    // The transient row still renders, but the editor owns the small model.
    expect(lines).toHaveLength(4);
    expect(lines.at(-1)).toContain("🎯 active");
    expect(lines.join("\n")).not.toContain("small synthetic/haiku");
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

  it("logs async watcher errors instead of crashing the session", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const tmp = await mkdtemp(join(tmpdir(), "status-bar-watch-error-"));
    const configPath = join(tmp, "small-model.json");
    await writeFile(configPath, "{}");
    vi.mocked(resolveSmallModelConfigPath).mockReturnValue(configPath);

    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    mockCtx.model = { id: "sonnet-4", provider: "anthropic" } as any;
    await enableBar(mockPi, mockCtx);

    // The bar attaches config watchers at enable time; grab the live handle
    // and deliver an async watcher error the way libuv does (volume removed,
    // resource limits). Without an error listener this throws uncaught.
    // The worker-model watcher's watch() call throws (missing dir), so pick
    // the last call that returned a watcher.
    const results = vi.mocked(watch).mock.results;
    const handle = [...results].reverse().find((r) => r.type === "return")?.value as
      | FSWatcher
      | undefined;
    expect(handle).toBeDefined();
    expect(() => handle?.emit("error", new Error("watch limit reached"))).not.toThrow();
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining("watcher failed:"),
      expect.objectContaining({ message: "watch limit reached" }),
    );

    // The bar keeps rendering after the watcher died.
    expect(renderInstalledEditor(mockCtx).render(100).length).toBeGreaterThan(0);
    debug.mockRestore();
  });
});

describe("status-bar worker roll-up", () => {
  function plainTheme() {
    return { fg: vi.fn((_color: string, text: string) => text) };
  }

  async function enableBarWithWorkers(
    mockPi: ReturnType<typeof createMockPi>,
    mockCtx: ReturnType<typeof createMockCommandContext>,
    payload: { running: number; workerCostUsd: number; workerTokens: number },
  ) {
    mockCtx.getContextUsage = vi.fn(() => ({
      tokens: 50000,
      contextWindow: 200000,
      percent: 25,
    }));
    await enableBar(mockPi, mockCtx);
    getEventsHandler(mockPi, "workers:state")(payload);
  }

  it("subscribes to workers:state at load time", async () => {
    const mockPi = createMockPi();
    await statusBarExtension(mockPi);
    expect(getEventsHandler(mockPi, "workers:state")).toBeDefined();
  });

  it("renders the worker spend segment when spend exists", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBarWithWorkers(mockPi, mockCtx, {
      running: 1,
      workerCostUsd: 0.041,
      workerTokens: 38100,
    });

    const component = getFooterFactory(mockCtx)({ requestRender: vi.fn() }, plainTheme(), {
      onBranchChange: vi.fn(),
      getGitBranch: () => null,
    });
    const text = component.render(160).join("\n");
    expect(text).toContain("⚙ $0.04");
    expect(text).toContain("38.1k");
  });

  it("hides the worker spend segment at zero", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBarWithWorkers(mockPi, mockCtx, {
      running: 0,
      workerCostUsd: 0,
      workerTokens: 0,
    });

    const component = getFooterFactory(mockCtx)({ requestRender: vi.fn() }, plainTheme(), {
      onBranchChange: vi.fn(),
      getGitBranch: () => null,
    });
    expect(component.render(160).join("\n")).not.toContain("⚙");
  });

  it("retains worker spend and session cost on narrow terminals", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBarWithWorkers(mockPi, mockCtx, {
      running: 1,
      workerCostUsd: 0.041,
      workerTokens: 38100,
    });

    // Stacked panels preserve spend instead of dropping it.
    const component = getFooterFactory(mockCtx)({ requestRender: vi.fn() }, plainTheme(), {
      onBranchChange: vi.fn(),
      getGitBranch: () => null,
    });
    for (let width = 24; width <= 160; width += 4) {
      const text = component.render(width).join(" ");
      expect(text, `width ${width}`).toContain("⚙ $0.04");
      expect(text, `width ${width}`).toContain("$0.000");
      expect(text, `width ${width}`).toContain("38.1k");
    }
  });
});
