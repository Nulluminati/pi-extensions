import { afterEach, describe, expect, it, vi } from "vitest";
import contextExtension from "../../extensions/context/context.ts";
import { measureContext, sumSessionUsage } from "../../extensions/context/src/measure.ts";
import { buildPlainText } from "../../extensions/context/src/view.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";

// --- Test helpers (bottom of file keeps the describe block readable) ---

function getCommandRegistration(mockPi: any): { name: string; options: any } {
  const calls = mockPi.registerCommand.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return { name: calls[0][0], options: calls[0][1] };
}

function getCommandHandler(mockPi: any): (args: string, ctx: any) => Promise<void> {
  return getCommandRegistration(mockPi).options.handler;
}

/** Chars/4 heuristic, mirroring the mocked estimateTokens implementation. */
function est(text: string): number {
  return Math.max(0, Math.ceil(text.length / 4));
}

const SESSION_ENTRIES = [
  {
    type: "message",
    message: {
      role: "user",
      content: "hello world this is a test message with enough text to estimate",
      timestamp: 1,
    },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "short" }],
      usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, cost: { total: 0.0042 } },
      timestamp: 2,
    },
  },
  {
    type: "message",
    message: {
      role: "toolResult",
      content: "some tool output text",
      toolName: "bash",
      timestamp: 3,
    },
  },
  { type: "custom", customType: "goal-state", data: {} },
];

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("context-extension", () => {
  const NULL_KEYBINDINGS = { matches: () => false };
  it("registers the /context command with a descriptive help text", async () => {
    const pi = createMockPi();

    await contextExtension(pi);

    const { name, options } = getCommandRegistration(pi);
    expect(name).toBe("context");
    expect(options.description).toContain("context window");
    expect(options.handler).toBeTypeOf("function");
  });

  it("registers a message renderer that hides stale context blocks from the transcript", async () => {
    const pi = createMockPi();

    await contextExtension(pi);

    expect(pi.registerMessageRenderer).toHaveBeenCalledWith("context", expect.any(Function));
    const renderer = pi.registerMessageRenderer.mock.calls.find(
      (call: unknown[]) => call[0] === "context",
    )?.[1] as () => undefined;
    expect(renderer()).toBeUndefined();
  });

  describe("measureContext", () => {
    it("reports provider usage, percent, and free space from getContextUsage", async () => {
      const pi = createMockPi();
      const ctx = createMockCommandContext();
      ctx.getContextUsage = vi.fn(() => ({
        tokens: 25_000,
        contextWindow: 128_000,
        percent: 19.5,
      }));

      const breakdown = measureContext(pi, ctx);

      expect(breakdown.usedTokens).toBe(25_000);
      expect(breakdown.contextWindow).toBe(128_000);
      expect(breakdown.percent).toBe(19.5);
      expect(breakdown.freeTokens).toBe(103_000);
      expect(breakdown.modelLabel).toBe("test-provider/test-model");
    });

    it("falls back to estimates when there is no provider usage yet", async () => {
      const pi = createMockPi();
      const ctx = createMockCommandContext();
      ctx.getContextUsage = vi.fn(() => undefined);

      const breakdown = measureContext(pi, ctx);

      expect(breakdown.usedTokens).toBeNull();
      expect(breakdown.percent).toBeNull();
      expect(breakdown.freeTokens).toBeNull();
      expect(breakdown.reserveTokens).toBe(16384);
    });

    it("measures the system prompt with the chars/4 heuristic", async () => {
      const pi = createMockPi();
      const ctx = createMockCommandContext();
      const prompt = "You are Pi, a coding agent.\n".repeat(20);
      ctx.getSystemPrompt = vi.fn(() => prompt);

      const breakdown = measureContext(pi, ctx);

      expect(breakdown.systemPromptTokens).toBe(est(prompt));
    });

    it("breaks context files down per file with cwd- and home-relative paths", async () => {
      vi.stubEnv("HOME", "/home/natekift");
      const pi = createMockPi();
      const ctx = createMockCommandContext();
      ctx.getSystemPromptOptions = vi.fn(() => ({
        cwd: "/home/test",
        contextFiles: [
          { path: "/home/test/AGENTS.md", content: "x".repeat(400) },
          { path: "/home/natekift/.pi/agent/AGENTS.md", content: "y".repeat(200) },
        ],
      }));

      const breakdown = measureContext(pi, ctx);

      expect(breakdown.contextFiles).toEqual([
        { path: "./AGENTS.md", tokens: 100 },
        { path: "~/.pi/agent/AGENTS.md", tokens: 50 },
      ]);
    });

    it("measures skill descriptions and active tool definitions", async () => {
      const pi = createMockPi();
      const ctx = createMockCommandContext();
      ctx.getSystemPromptOptions = vi.fn(() => ({
        cwd: "/home/test",
        skills: [
          { name: "write-tests", description: "d".repeat(100) },
          { name: "humanizer", description: "e".repeat(40) },
        ],
      }));
      const readParams = { type: "object", properties: {} };
      const bashParams = { type: "object", properties: {} };
      pi.getActiveTools = vi.fn(() => ["read", "bash"]);
      pi.getAllTools = vi.fn(() => [
        { name: "read", description: "Read file contents", parameters: readParams, sourceInfo: {} },
        {
          name: "bash",
          description: "Execute shell commands",
          parameters: bashParams,
          sourceInfo: {},
        },
      ]);

      const breakdown = measureContext(pi, ctx);

      expect(breakdown.skills).toEqual([
        { name: "write-tests", tokens: 25 },
        { name: "humanizer", tokens: 10 },
      ]);
      const readBlob = `read\nRead file contents\n${JSON.stringify(readParams)}`;
      const bashBlob = `bash\nExecute shell commands\n${JSON.stringify(bashParams)}`;
      expect(breakdown.toolsTokens).toBe(est(readBlob) + est(bashBlob));
      expect(breakdown.activeToolCount).toBe(2);
    });

    it("counts messages, estimates their tokens, and ranks the largest", async () => {
      const pi = createMockPi();
      const ctx = createMockCommandContext();
      ctx.sessionManager.getBranch = vi.fn(() => SESSION_ENTRIES);

      const breakdown = measureContext(pi, ctx);

      expect(breakdown.messageCount).toBe(3);
      const userText = "hello world this is a test message with enough text to estimate";
      expect(breakdown.messageTokens).toBe(
        est(userText) + est("short") + est("some tool output text"),
      );
      expect(breakdown.largestMessages.map((m) => m.tokens)).toEqual([
        est(userText),
        est("some tool output text"),
        est("short"),
      ]);
      expect(breakdown.largestMessages[0]?.role).toBe("user");
      expect(breakdown.largestMessages[0]?.preview).toBe(userText.slice(0, 48));
    });

    it("sums provider usage only from assistant messages", async () => {
      const entries = [
        ...SESSION_ENTRIES,
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "second response" }],
            usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.5 },
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "no usage attached" }],
          },
        },
      ];

      const totals = sumSessionUsage(entries);

      expect(totals).toEqual({
        input: 150,
        output: 25,
        cacheRead: 30,
        cacheWrite: 10,
        totalTokens: 215,
        cost: 0.5042,
      });
    });
  });

  describe("command handler", () => {
    it("shows the breakdown in a modal in TUI mode", async () => {
      const pi = createMockPi();
      const ctx = createMockCommandContext();
      ctx.getContextUsage = vi.fn(() => ({
        tokens: 25_000,
        contextWindow: 128_000,
        percent: 19.5,
      }));
      ctx.getSystemPrompt = vi.fn(() => "You are Pi.\n".repeat(40));
      ctx.sessionManager.getBranch = vi.fn(() => SESSION_ENTRIES);

      let component: any;
      ctx.ui.custom = vi.fn(
        (factory: any) =>
          new Promise((resolve) => {
            component = factory(
              { requestRender: vi.fn(), terminal: { rows: 40 } },
              ctx.ui.theme,
              NULL_KEYBINDINGS,
              resolve,
            );
          }),
      );

      await contextExtension(pi);
      const handler = getCommandHandler(pi);
      const done = handler("", ctx);

      expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
      const lines = component.render(80).join("\n");
      expect(lines).toContain("Used: 25.0k / 128.0k");
      expect(lines).toContain("System prompt");
      expect(lines).toContain("Messages");
      expect(lines).toContain("Free space");
      expect(lines).toContain("Compaction buffer");
      expect(lines).toContain("Largest messages");
      expect(lines).toContain("Session:");

      component.handleInput("\r");
      await done;
    });

    it("renders an unknown-usage state before the first assistant response", async () => {
      const pi = createMockPi();
      const ctx = createMockCommandContext();
      ctx.getContextUsage = vi.fn(() => undefined);
      ctx.sessionManager.getBranch = vi.fn(() => []);

      let component: any;
      ctx.ui.custom = vi.fn(
        (factory: any) =>
          new Promise((resolve) => {
            component = factory(
              { requestRender: vi.fn(), terminal: { rows: 40 } },
              ctx.ui.theme,
              NULL_KEYBINDINGS,
              resolve,
            );
          }),
      );

      await contextExtension(pi);
      const handler = getCommandHandler(pi);
      const done = handler("", ctx);

      const lines = component.render(80).join("\n");
      expect(lines).toContain("(unknown");
      expect(lines).not.toContain("Free space");

      component.handleInput("q");
      await done;
    });

    it("closes on kitty-protocol escape sequences via the keybindings manager", async () => {
      const pi = createMockPi();
      const ctx = createMockCommandContext();
      ctx.getContextUsage = vi.fn(() => ({
        tokens: 25_000,
        contextWindow: 128_000,
        percent: 19.5,
      }));

      let component: any;
      const done = vi.fn();
      let resolveModal!: (value: void) => void;
      ctx.ui.custom = vi.fn(
        (factory: any) =>
          new Promise<void>((resolve) => {
            resolveModal = resolve;
            // Mimic pi's KeybindingsManager as a real class-method object:
            // `matches` reads internal state through `this`. Esc resolves in
            // every byte variant, including kitty-protocol CSI sequences that
            // raw-byte checks (data === "\u001b") miss.
            const keybindings = {
              bindings: {
                "\u001b": ["tui.select.cancel"],
                "\u001b[27u": ["tui.select.cancel"],
              } as Record<string, string[]>,
              matches(data: string, keybinding: string) {
                return (this.bindings[data] ?? []).includes(keybinding);
              },
            };
            component = factory(
              { requestRender: vi.fn(), terminal: { rows: 40 } },
              ctx.ui.theme,
              keybindings,
              () => {
                done();
                resolve();
              },
            );
          }),
      );

      await contextExtension(pi);
      const handler = getCommandHandler(pi);
      const pending = handler("", ctx);

      component.handleInput("\u001b[27u");
      expect(done).toHaveBeenCalled();
      resolveModal();
      await pending;
    });

    it("delivers a plain-text breakdown via sendMessage without UI", async () => {
      const pi = createMockPi();
      const ctx = createMockCommandContext();
      ctx.hasUI = false;
      ctx.mode = "print";
      ctx.getContextUsage = vi.fn(() => ({
        tokens: 25_000,
        contextWindow: 128_000,
        percent: 19.5,
      }));
      ctx.getSystemPrompt = vi.fn(() => "You are Pi.\n".repeat(40));
      ctx.sessionManager.getBranch = vi.fn(() => SESSION_ENTRIES);

      await contextExtension(pi);
      const handler = getCommandHandler(pi);
      await handler("", ctx);

      expect(ctx.ui.custom).not.toHaveBeenCalled();
      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
      const [message] = pi.sendMessage.mock.calls[0];
      expect(message.customType).toBe("context");
      expect(message.display).toBe(true);
      const text = message.content[0].text;
      expect(text).toContain("Used: 25.0k / 128.0k (19.5%");
      expect(text).toContain("System prompt:");
      expect(text).toContain("Messages:");
      expect(text).toContain("Session totals:");
    });
  });

  describe("buildPlainText", () => {
    it("formats a complete breakdown as readable lines", async () => {
      const pi = createMockPi();
      const ctx = createMockCommandContext();
      ctx.getContextUsage = vi.fn(() => ({
        tokens: 25_000,
        contextWindow: 128_000,
        percent: 19.5,
      }));
      ctx.getSystemPrompt = vi.fn(() => "x".repeat(400));
      ctx.getSystemPromptOptions = vi.fn(() => ({
        cwd: "/home/test",
        contextFiles: [{ path: "/home/test/AGENTS.md", content: "x".repeat(400) }],
        skills: [{ name: "write-tests", description: "d".repeat(100) }],
      }));
      ctx.sessionManager.getBranch = vi.fn(() => SESSION_ENTRIES);

      const text = buildPlainText(measureContext(pi, ctx));

      expect(text).toContain("Model: test-provider/test-model");
      expect(text).toContain("System prompt: 100 (est)");
      expect(text).toContain("    ./AGENTS.md: 100");
      expect(text).toContain("Skills (1): 25");
      expect(text).toContain("Free space: 103.0k");
      expect(text).toContain("Compaction buffer: 16.4k (reserved)");
      expect(text).toContain("↑100 ↓20 ↗30 ↘10");
      expect(text).toContain("$0.0042");
    });
  });
});
