import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionCommandContext } from "pi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handoffExtension, { STATUS_ICON } from "../../extensions/handoff/handoff.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { getCommandHandler } from "../mocks/test-helpers.ts";

vi.mock("@earendil-works/pi-ai", () => ({
  completeSimple: vi.fn(),
}));

function buildBranch(): unknown[] {
  return [
    {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "Refactor the auth middleware" }],
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "I moved the token validation into a dedicated function and added unit tests.",
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "bash",
        content: [{ type: "text", text: "Tests passed" }],
      },
    },
  ];
}

async function runHandoff(
  mockPi: ReturnType<typeof createMockPi>,
  mockCtx: ReturnType<typeof createMockCommandContext>,
  args: string,
) {
  await handoffExtension(mockPi);
  const handler = getCommandHandler(mockPi, "handoff");
  await handler(args, mockCtx);
}

describe("handoff-extension", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("PI_SMALL_MODEL", "test-provider/test-model");
    vi.stubEnv("PI_SMALL_MODEL_THINKING", "minimal");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("file structure", () => {
    it("keeps one discoverable entrypoint and implementation modules under src", async () => {
      const extensionDir = resolve(import.meta.dirname, "../../extensions/handoff");
      const rootEntries = await readdir(extensionDir, { withFileTypes: true });
      const rootTypeScriptFiles = rootEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => entry.name);
      const sourceFiles = await readdir(resolve(extensionDir, "src"));

      expect(rootTypeScriptFiles).toEqual(["handoff.ts"]);
      expect(sourceFiles.filter((file) => file.endsWith(".ts"))).toHaveLength(4);
    });
  });

  it("registers /handoff command", async () => {
    const mockPi = createMockPi();
    await handoffExtension(mockPi);
    expect(mockPi.registerCommand).toHaveBeenCalledTimes(1);
    expect(mockPi.registerCommand).toHaveBeenCalledWith(
      "handoff",
      expect.objectContaining({
        description: "Summarize the current session and start a new focused session",
        handler: expect.any(Function),
      }),
    );
  });

  it("prompts for a goal when called without args in UI mode", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.ui.input = vi.fn(() => Promise.resolve("finish the refactor"));
    mockCtx.sessionManager.getBranch = vi.fn(buildBranch);
    mockCtx.sessionManager.getSessionFile = vi.fn(() => "/sessions/old.json");
    mockCtx.ui.editor = vi.fn(() => Promise.resolve("edited summary"));

    const { completeSimple } = await import("@earendil-works/pi-ai");
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: "summary text" }],
    });

    await runHandoff(mockPi, mockCtx, "");

    expect(mockCtx.ui.input).toHaveBeenCalledWith(
      "Handoff goal",
      "What should the new session focus on?",
    );
    expect(mockCtx.newSession).toHaveBeenCalled();
  });

  it("warns when called without args in non-UI mode", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.hasUI = false;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runHandoff(mockPi, mockCtx, "");

    expect(warnSpy).toHaveBeenCalledWith("Usage: /handoff <goal>");
    expect(mockCtx.newSession).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("errors when goal exceeds max length", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();

    await runHandoff(mockPi, mockCtx, "x".repeat(4001));

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("too long"), "warning");
    expect(mockCtx.newSession).not.toHaveBeenCalled();
  });

  it("errors when the global small model is unavailable without using the active model", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(buildBranch);
    mockCtx.modelRegistry.find = vi.fn(() => undefined);

    await runHandoff(mockPi, mockCtx, "finish the refactor");

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Global small model not found"),
      "error",
    );
    const { completeSimple } = await import("@earendil-works/pi-ai");
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("errors when there is no conversation to hand off", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(() => []);

    await runHandoff(mockPi, mockCtx, "finish the refactor");

    expect(mockCtx.ui.notify).toHaveBeenCalledWith("No conversation to hand off.", "error");
  });

  it("shows status while generating summary", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(buildBranch);
    mockCtx.sessionManager.getSessionFile = vi.fn(() => "/sessions/old.json");
    mockCtx.ui.editor = vi.fn(() => Promise.resolve("edited summary"));

    const { completeSimple } = await import("@earendil-works/pi-ai");
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: "summary text" }],
    });

    await runHandoff(mockPi, mockCtx, "finish the refactor");

    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith(
      "handoff",
      expect.stringContaining(STATUS_ICON),
    );
    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith(
      "handoff",
      expect.stringContaining("Generating handoff summary…"),
    );
    expect(mockCtx.ui.setStatus).toHaveBeenLastCalledWith("handoff", undefined);
  });

  it("prioritizes recent transcript segments when the transcript exceeds the budget", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(() => [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: `EARLY_MARKER ${"x".repeat(1200)}` }],
        },
      },
      ...Array.from({ length: 35 }, (_, index) => ({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `${index === 15 ? "MID_BUDGET_MARKER" : `middle-${index}`} ${"x".repeat(1200)}`,
            },
          ],
        },
      })),
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "RECENT_MARKER finish this work" }],
        },
      },
    ]);
    mockCtx.ui.editor = vi.fn(() => Promise.resolve(undefined));

    const { completeSimple } = await import("@earendil-works/pi-ai");
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: "summary text" }],
    });

    await runHandoff(mockPi, mockCtx, "finish the refactor");

    const request = vi.mocked(completeSimple).mock.calls[0][1].messages[0].content[0].text;
    const transcript = request.match(
      /<conversation_transcript>\n([\s\S]*)\n<\/conversation_transcript>/,
    )?.[1];
    expect(transcript).toBeDefined();
    expect(transcript).toContain("RECENT_MARKER");
    expect(transcript).toContain("MID_BUDGET_MARKER");
    expect(transcript).not.toContain("EARLY_MARKER");
    expect(transcript?.length).toBeLessThanOrEqual(36000);
  });

  it("performs a full handoff with the global small model in UI mode", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    const activeModel = mockCtx.model;
    const smallModel = {
      ...activeModel,
      id: "small-model",
      name: "Small Model",
      provider: "small-provider",
      reasoning: true,
    };
    vi.stubEnv("PI_SMALL_MODEL", "small-provider/small-model");
    mockCtx.modelRegistry.find = vi.fn(() => smallModel);
    mockCtx.sessionManager.getBranch = vi.fn(buildBranch);
    mockCtx.sessionManager.getSessionFile = vi.fn(() => "/sessions/old.json");
    mockCtx.ui.editor = vi.fn(() => Promise.resolve("edited summary"));

    const { completeSimple } = await import("@earendil-works/pi-ai");
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: "summary text" }],
    });

    await runHandoff(mockPi, mockCtx, "finish the refactor");

    expect(completeSimple).toHaveBeenCalledWith(
      smallModel,
      expect.objectContaining({
        systemPrompt: expect.stringContaining("handoff summaries"),
        messages: [
          expect.objectContaining({
            role: "user",
            content: [{ type: "text", text: expect.stringContaining("finish the refactor") }],
          }),
        ],
      }),
      expect.objectContaining({ apiKey: "test-key", maxTokens: 2048, reasoning: "minimal" }),
    );
    expect(completeSimple).not.toHaveBeenCalledWith(
      activeModel,
      expect.anything(),
      expect.anything(),
    );

    expect(mockCtx.ui.editor).toHaveBeenCalledWith("Review handoff prompt", "summary text");
    expect(mockCtx.newSession).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSession: "/sessions/old.json",
        setup: expect.any(Function),
        withSession: expect.any(Function),
      }),
    );
    expect(mockPi.setSessionName).not.toHaveBeenCalled();
  });

  it("uses only replacement-session APIs after creating the new session", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    const replacementCtx = createMockCommandContext();
    const setupSessionManager = { appendSessionInfo: vi.fn() };
    mockCtx.sessionManager.getBranch = vi.fn(buildBranch);
    mockCtx.sessionManager.getSessionFile = vi.fn(() => "/sessions/old.json");
    mockCtx.ui.editor = vi.fn(() => Promise.resolve("edited summary"));
    mockCtx.ui.notify = vi.fn(() => {
      throw new Error("stale command ctx");
    });
    mockPi.setSessionName = vi.fn(() => {
      throw new Error("stale extension API");
    });
    mockCtx.newSession = vi.fn(
      async (options: Parameters<ExtensionCommandContext["newSession"]>[0]) => {
        await options?.setup?.(setupSessionManager);
        await options?.withSession?.(replacementCtx);
        return { cancelled: false };
      },
    );

    const { completeSimple } = await import("@earendil-works/pi-ai");
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: "summary text" }],
    });

    await expect(runHandoff(mockPi, mockCtx, "finish the refactor")).resolves.toBeUndefined();

    expect(setupSessionManager.appendSessionInfo).toHaveBeenCalledWith("Finish the refactor");
    expect(replacementCtx.ui.setEditorText).toHaveBeenCalledWith("edited summary");
    expect(replacementCtx.ui.notify).toHaveBeenCalledWith(
      "Handoff ready. Press Enter to continue in the new session.",
      "info",
    );
    expect(mockPi.setSessionName).not.toHaveBeenCalled();
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });

  it("prints summary and skips session creation in non-UI mode", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.hasUI = false;
    mockCtx.sessionManager.getBranch = vi.fn(buildBranch);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { completeSimple } = await import("@earendil-works/pi-ai");
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: "print mode summary" }],
    });

    await runHandoff(mockPi, mockCtx, "finish the refactor");

    expect(logSpy).toHaveBeenCalledWith("print mode summary");
    expect(mockCtx.newSession).not.toHaveBeenCalled();
    expect(mockPi.setSessionName).not.toHaveBeenCalled();

    logSpy.mockRestore();
  });

  it("cancels when the editor is dismissed", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(buildBranch);
    mockCtx.ui.editor = vi.fn(() => Promise.resolve(undefined));

    const { completeSimple } = await import("@earendil-works/pi-ai");
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: "summary text" }],
    });

    await runHandoff(mockPi, mockCtx, "finish the refactor");

    expect(mockCtx.ui.notify).toHaveBeenCalledWith("Handoff cancelled.", "info");
    expect(mockCtx.newSession).not.toHaveBeenCalled();
  });

  it("notifies on LLM error and does not create a session", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(buildBranch);

    const { completeSimple } = await import("@earendil-works/pi-ai");
    vi.mocked(completeSimple).mockRejectedValue(new Error("rate limited"));

    await runHandoff(mockPi, mockCtx, "finish the refactor");

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      "Failed to generate handoff summary: rate limited",
      "error",
    );
    expect(mockCtx.newSession).not.toHaveBeenCalled();
  });

  it("notifies when the model returns empty content", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(buildBranch);

    const { completeSimple } = await import("@earendil-works/pi-ai");
    vi.mocked(completeSimple).mockResolvedValue({ content: [] });

    await runHandoff(mockPi, mockCtx, "finish the refactor");

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      "Model returned an empty handoff summary.",
      "error",
    );
  });

  it("notifies when new session is cancelled", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(buildBranch);
    mockCtx.sessionManager.getSessionFile = vi.fn(() => "/sessions/old.json");
    mockCtx.ui.editor = vi.fn(() => Promise.resolve("edited summary"));
    mockCtx.newSession = vi.fn(() => Promise.resolve({ cancelled: true }));

    const { completeSimple } = await import("@earendil-works/pi-ai");
    vi.mocked(completeSimple).mockResolvedValue({
      content: [{ type: "text", text: "summary text" }],
    });

    await runHandoff(mockPi, mockCtx, "finish the refactor");

    expect(mockCtx.ui.notify).toHaveBeenCalledWith("New session cancelled.", "info");
  });
});
