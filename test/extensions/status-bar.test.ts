import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import statusBarExtension, {
  buildEditorMetaSegments,
  renderPolishedFrame,
  STATUS_ICON,
} from "../../extensions/status-bar/status-bar.ts";
import {
  type EditorFactory,
  hasEditorFactoryLayer,
  installEditorFactoryLayer,
} from "../../lib/editor-factory.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { getEventHandler } from "../mocks/test-helpers.ts";

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
  });

  it("registers /statusbar command", async () => {
    const mockPi = createMockPi();
    await statusBarExtension(mockPi);
    expect(mockPi.registerCommand).toHaveBeenCalledWith(
      "statusbar",
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
    expect(mockPi.on).toHaveBeenCalledWith("tool_execution_start", expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith("tool_execution_end", expect.any(Function));
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

  it("/statusbar disables the footer when already enabled", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const handler = mockPi.registerCommand.mock.calls[0][1].handler;
    await handler("", mockCtx);

    expect(mockCtx.ui.setFooter).toHaveBeenCalledWith(undefined);
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith("status-bar", undefined);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("disabled"), "info");
  });

  it("/statusbar re-enables the footer after being disabled", async () => {
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
          ["goal", "🎯 active"],
          ["small-model", "small synthetic/syn:small:text · minimal"],
          ["other", "some status"],
        ]),
      }),
    );
    const lines = component.render(120);

    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("🎯 active");
    expect(lines[1]).toContain("small synthetic/syn:small:text · minimal");
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
          ["goal", "🎯 active"],
        ]),
      }),
    );
    const lines = component.render(120);

    expect(lines[1]).not.toContain(`${STATUS_ICON} statusbar`);
    expect(lines[1]).toContain("🎯 active");
  });

  it("active tool progress appears on line 2", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const toolStartHandler = getEventHandler(mockPi, "tool_execution_start");
    await toolStartHandler(
      { type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: {} },
      mockCtx,
    );

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    const lines = component.render(120);

    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("⚙");
    expect(lines[1]).toContain("bash");
  });

  it("completed tool count appears on line 2", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const toolStartHandler = getEventHandler(mockPi, "tool_execution_start");
    await toolStartHandler(
      { type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: {} },
      mockCtx,
    );
    const toolEndHandler = getEventHandler(mockPi, "tool_execution_end");
    await toolEndHandler(
      {
        type: "tool_execution_end",
        toolCallId: "tc-1",
        toolName: "bash",
        result: {},
        isError: false,
      },
      mockCtx,
    );

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    const lines = component.render(120);

    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("✓1");
    expect(lines[1]).not.toContain("⚙");
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

  it("session_start resets tool execution state and token usage", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    await enableBar(mockPi, mockCtx);

    const toolStartHandler = getEventHandler(mockPi, "tool_execution_start");
    await toolStartHandler(
      { type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: {} },
      mockCtx,
    );

    const sessionStartHandler = getEventHandler(mockPi, "session_start");
    await sessionStartHandler({ type: "session_start", reason: "new" }, mockCtx);

    const component = getFooterFactory(mockCtx)(
      { requestRender: vi.fn() },
      plainTheme(),
      footerData(),
    );
    const lines = component.render(120);

    // Only 1 line — tools and tokens reset, line 2 collapses.
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

// === Polished editor frame (pure layout) ===

describe("status-bar editor frame", () => {
  function plainTheme() {
    return { fg: vi.fn((_c: string, t: string) => t) };
  }

  /** Simulate the base editor's render output: top border, content, bottom border. */
  function baseOutput(content: string[], width = 40): string[] {
    return ["─".repeat(width), ...content, "─".repeat(width)];
  }

  it("draws a full-width grey top and bottom border", () => {
    const lines = renderPolishedFrame({
      baseRendered: baseOutput(["hello"]),
      autocompleteCount: 0,
      width: 40,
      metaSegments: ["anthropic/claude"],
      theme: plainTheme(),
    });
    expect(lines[0]).toBe("─".repeat(40));
    expect(lines[lines.length - 1]).toBe("─".repeat(40));
  });

  it("strips the base editor's own borders so there is no double border", () => {
    const lines = renderPolishedFrame({
      baseRendered: baseOutput(["hello", "world"]),
      autocompleteCount: 0,
      width: 40,
      metaSegments: ["anthropic/claude"],
      theme: plainTheme(),
    });
    // First and last lines are the frame borders; the base's borders were
    // stripped, so the content lines appear exactly once in the frame.
    expect(lines.filter((l) => l.includes("hello"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("world"))).toHaveLength(1);
  });

  it("renders model and thinking segments on a metadata line inside the frame", () => {
    const lines = renderPolishedFrame({
      baseRendered: baseOutput(["hello"]),
      autocompleteCount: 0,
      width: 60,
      metaSegments: ["anthropic/claude-sonnet-4-6", " high"],
      theme: plainTheme(),
    });
    // The meta line is the last railed line before the bottom border.
    const metaLine = lines[lines.length - 2];
    expect(metaLine).toContain("anthropic/claude-sonnet-4-6");
    expect(metaLine).toContain("high");
  });

  it("adds a blank gap so the box is taller than the base editor", () => {
    const base = baseOutput(["hello"]);
    const lines = renderPolishedFrame({
      baseRendered: base,
      autocompleteCount: 0,
      width: 40,
      metaSegments: ["anthropic/claude"],
      theme: plainTheme(),
    });
    // base = [border, hello, border] (3 lines).
    // frame = [border, hello, blank, meta, border] (5 lines): +2 taller.
    expect(lines.length).toBe(base.length + 2);
  });

  it("places autocomplete lines below the bottom border", () => {
    const ac1 = "  cmd1  description";
    const ac2 = "  cmd2  description";
    const lines = renderPolishedFrame({
      baseRendered: [...baseOutput(["hello"]), ac1, ac2],
      autocompleteCount: 2,
      width: 40,
      metaSegments: ["anthropic/claude"],
      theme: plainTheme(),
    });
    // Bottom border is the last frame line; autocomplete follows it.
    const bottomIdx = lines.lastIndexOf("─".repeat(40));
    expect(lines[bottomIdx + 1]).toBe(ac1);
    expect(lines[bottomIdx + 2]).toBe(ac2);
  });

  it("never exceeds the given width on any line", () => {
    const lines = renderPolishedFrame({
      baseRendered: baseOutput(["a".repeat(80)]),
      autocompleteCount: 0,
      width: 40,
      metaSegments: ["anthropic/claude-sonnet-4-6", "high"],
      theme: plainTheme(),
    });
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });

  it("uses the borderMuted color for the frame", () => {
    const fgMock = vi.fn((_c: string, t: string) => t);
    renderPolishedFrame({
      baseRendered: baseOutput(["hello"]),
      autocompleteCount: 0,
      width: 40,
      metaSegments: ["anthropic/claude"],
      theme: { fg: fgMock },
    });
    expect(fgMock).toHaveBeenCalledWith("borderMuted", expect.any(String));
  });

  it("falls back to truncated base output when width is too small to frame", () => {
    const base = baseOutput(["hello"], 10);
    const lines = renderPolishedFrame({
      baseRendered: base,
      autocompleteCount: 0,
      width: 2,
      metaSegments: ["anthropic/claude"],
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

  it("/statusbar disable restores the default editor and re-enable reinstalls", async () => {
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
