import {
  // @ts-expect-error unresolved re-export in pi-coding-agent's declarations
  // (TypeScript 7.0.2 preview); the vitest package mock supplies the function.
  formatSkillsForPrompt,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "pi";
import { afterEach, describe, expect, it, vi } from "vitest";
import contextExtension from "../../extensions/context/context.ts";
import { measureContext, sumSessionUsage } from "../../extensions/context/src/measure.ts";
import { buildPlainText } from "../../extensions/context/src/view.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";

// --- Test helpers (bottom of file keeps the describe block readable) ---

interface RegisteredCommand {
  name: string;
  options: {
    description: string;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  };
}

function getCommandRegistration(mockPi: {
  registerCommand: { mock: { calls: unknown[][] } };
}): RegisteredCommand {
  const calls = mockPi.registerCommand.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const call = calls[0];
  if (!call) throw new Error("no command registered");
  return { name: call[0] as string, options: call[1] as RegisteredCommand["options"] };
}

function getCommandHandler(mockPi: {
  registerCommand: { mock: { calls: unknown[][] } };
}): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
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

    it("measures the embedded skills section and active tool definitions", async () => {
      const pi = createMockPi();
      const ctx = createMockCommandContext();
      const skills = [
        {
          name: "write-tests",
          description: "d".repeat(100),
          filePath: "/home/test/.pi/skills/write-tests/SKILL.md",
        },
        {
          name: "humanizer",
          description: "e".repeat(40),
          filePath: "/home/test/.agents/skills/humanizer/SKILL.md",
        },
      ];
      ctx.getSystemPromptOptions = vi.fn(() => ({
        cwd: "/home/test",
        selectedTools: ["read", "bash", "edit", "write"],
        skills,
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

      const section = formatSkillsForPrompt(skills, "read").trim();
      expect(breakdown.skillsTokens).toBe(est(section));
      expect(breakdown.skillCount).toBe(2);
      const readBlob = `read\nRead file contents\n${JSON.stringify(readParams)}`;
      const bashBlob = `bash\nExecute shell commands\n${JSON.stringify(bashParams)}`;
      expect(breakdown.toolsTokens).toBe(est(readBlob) + est(bashBlob));
      expect(breakdown.activeToolCount).toBe(2);
    });

    it("excludes the skills section when no read or bash tool is selected", async () => {
      const pi = createMockPi();
      const ctx = createMockCommandContext();
      ctx.getSystemPromptOptions = vi.fn(() => ({
        cwd: "/home/test",
        selectedTools: ["edit", "write"],
        skills: [{ name: "write-tests", description: "d".repeat(100), filePath: "/s/SKILL.md" }],
      }));

      const breakdown = measureContext(pi, ctx);

      expect(breakdown.skillsTokens).toBe(0);
      expect(breakdown.skillCount).toBe(1);
    });

    it("derives the base prompt so the system prompt rows reconcile", async () => {
      const pi = createMockPi();
      const ctx = createMockCommandContext();
      const fileContent = "f".repeat(400);
      const skills = [
        { name: "write-tests", description: "d".repeat(100), filePath: "/s/SKILL.md" },
      ];
      const section = formatSkillsForPrompt(skills, "read").trim();
      ctx.getSystemPromptOptions = vi.fn(() => ({
        cwd: "/home/test",
        selectedTools: ["read"],
        contextFiles: [{ path: "/home/test/AGENTS.md", content: fileContent }],
        skills,
      }));
      const prompt = `Preamble\n\n${fileContent}\n\n${section}\n\n/home/test`;
      ctx.getSystemPrompt = vi.fn(() => prompt);

      const breakdown = measureContext(pi, ctx);

      expect(breakdown.systemPromptTokens).toBe(est(prompt));
      expect(breakdown.basePromptTokens).toBe(
        breakdown.systemPromptTokens - est(fileContent) - est(section),
      );
      expect(breakdown.basePromptTokens).toBeGreaterThan(0);
    });

    it("clamps the base prompt remainder at zero when estimates overshoot", async () => {
      const pi = createMockPi();
      const ctx = createMockCommandContext();
      ctx.getSystemPrompt = vi.fn(() => "tiny");
      ctx.getSystemPromptOptions = vi.fn(() => ({
        cwd: "/home/test",
        selectedTools: ["read"],
        contextFiles: [{ path: "/home/test/AGENTS.md", content: "x".repeat(400) }],
        skills: [{ name: "write-tests", description: "d".repeat(100), filePath: "/s/SKILL.md" }],
      }));

      const breakdown = measureContext(pi, ctx);

      expect(breakdown.basePromptTokens).toBe(0);
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

    it("sums usage across assistant, toolResult, usage, compaction, and branch_summary entries", async () => {
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
        {
          // Codemode nested LLM calls (image, classifier, nested tools) roll
          // their usage into the top-level toolResult.
          type: "message",
          message: {
            role: "toolResult",
            content: "rolled-up nested usage",
            toolName: "bash",
            usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } },
          },
        },
        {
          type: "usage",
          usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0001 } },
        },
        {
          type: "compaction",
          usage: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0002 } },
        },
        {
          type: "branch_summary",
          usage: { input: 9, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0003 } },
        },
      ];

      const totals = sumSessionUsage(entries);

      // Each entry counted once; nested usage inside the toolResult roll-up
      // is not recounted.
      expect(totals.input).toBe(271);
      expect(totals.output).toBe(75);
      expect(totals.cacheRead).toBe(30);
      expect(totals.cacheWrite).toBe(10);
      expect(totals.totalTokens).toBe(386);
      expect(totals.cost).toBeCloseTo(1.5048, 10);
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

      let component!: { render(width: number): string[]; handleInput(data: string): void };
      ctx.ui.custom = vi.fn(
        // biome-ignore lint/suspicious/noExplicitAny: test mock
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
      expect(ctx.ui.custom).toHaveBeenCalledWith(expect.any(Function), {
        overlay: true,
        overlayOptions: { width: "70%", maxHeight: "80%", anchor: "center" },
      });
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

      let component!: { render(width: number): string[]; handleInput(data: string): void };
      ctx.ui.custom = vi.fn(
        // biome-ignore lint/suspicious/noExplicitAny: test mock
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

      let component!: { render(width: number): string[]; handleInput(data: string): void };
      const done = vi.fn();
      let resolveModal!: () => void;
      ctx.ui.custom = vi.fn(
        // biome-ignore lint/suspicious/noExplicitAny: test mock
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
      const fileContent = "f".repeat(400);
      const skills = [
        {
          name: "write-tests",
          description: "d".repeat(100),
          filePath: "/home/test/.pi/skills/write-tests/SKILL.md",
        },
      ];
      const section = formatSkillsForPrompt(skills, "read").trim();
      ctx.getSystemPrompt = vi.fn(
        () => `Base instructions.\n\n${fileContent}\n\n${section}\n\n/home/test`,
      );
      ctx.getSystemPromptOptions = vi.fn(() => ({
        cwd: "/home/test",
        selectedTools: ["read", "bash", "edit", "write"],
        contextFiles: [{ path: "/home/test/AGENTS.md", content: fileContent }],
        skills,
      }));
      ctx.sessionManager.getBranch = vi.fn(() => SESSION_ENTRIES);

      const text = buildPlainText(measureContext(pi, ctx));

      const prompt = ctx.getSystemPrompt();
      const base = est(prompt) - est(fileContent) - est(section);
      expect(text).toContain("Model: test-provider/test-model");
      expect(text).toContain(`System prompt: ${est(prompt)} (est)`);
      expect(text).toContain(`Base prompt: ${base}`);
      expect(text).toContain("    ./AGENTS.md: 100");
      expect(text).toContain(`Skills (1): ${est(section)}`);
      expect(text).toContain("Tools: 0 (0 active, sent as the API tools parameter)");
      expect(text).toContain("Free space: 103.0k");
      expect(text).toContain("Compaction buffer: 16.4k (reserved)");
      expect(text).toContain("↑100 ↓20 ↗30 ↘10");
      expect(text).toContain("$0.0042");
    });
  });
});
