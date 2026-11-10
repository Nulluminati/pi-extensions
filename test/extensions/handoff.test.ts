import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handoffExtension from "../../extensions/handoff/handoff.ts";
import { createMockCommandContext, createMockModel } from "../mocks/context-mocks.ts";
import { mockFn } from "../mocks/mock-types.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import {
  fakeTui,
  firstContentText,
  getCommandHandler,
  sessionEntries,
} from "../mocks/test-helpers.ts";

// test/setup/pi-coding-agent.ts stubs the package; the session manager is real.
const { SessionManager } = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
  "@earendil-works/pi-coding-agent",
);

vi.mock("@earendil-works/pi-ai/compat", () => ({
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
      expect(sourceFiles.filter((file) => file.endsWith(".ts"))).toHaveLength(3);
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

  it("drafts a summary when called without a goal", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCustomResolvesOnDone(mockCtx);
    const setupSessionManager = SessionManager.inMemory();
    vi.spyOn(setupSessionManager, "appendSessionInfo");
    mockCtx.sessionManager.getBranch = vi.fn(() => sessionEntries(buildBranch()));
    mockCtx.sessionManager.getSessionFile = vi.fn(() => "/sessions/old.json");
    mockCtx.ui.editor = vi.fn(() => Promise.resolve("edited summary"));
    mockCtx.newSession = vi.fn(
      async (options: Parameters<ExtensionCommandContext["newSession"]>[0]) => {
        await options?.setup?.(setupSessionManager);
        return { cancelled: false };
      },
    );

    const { completeSimple } = await import("@earendil-works/pi-ai/compat");
    vi.mocked(completeSimple).mockResolvedValue(
      fauxAssistantMessage([{ type: "text", text: "summary text" }]),
    );

    await runHandoff(mockPi, mockCtx, "");

    // Only the loading modal opens — no goal prompt.
    expect(mockCtx.ui.custom).toHaveBeenCalledTimes(1);
    expect(mockCtx.ui.editor).toHaveBeenCalledWith("Review handoff prompt", "summary text");
    // The summary prompt omits the goal line and steers from the transcript.
    const request = firstContentText(vi.mocked(completeSimple).mock.calls[0][1].messages[0]) ?? "";
    expect(request).not.toContain("Goal for the new session");
    // The session falls back to the generic name.
    expect(setupSessionManager.appendSessionInfo).toHaveBeenCalledWith("Handoff session");
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
    mockCustomResolvesOnDone(mockCtx);
    mockCtx.sessionManager.getBranch = vi.fn(() => sessionEntries(buildBranch()));
    mockCtx.modelRegistry.find = vi.fn(() => undefined);

    await runHandoff(mockPi, mockCtx, "finish the refactor");

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Global small model not found"),
      "error",
    );
    const { completeSimple } = await import("@earendil-works/pi-ai/compat");
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("errors when there is no conversation to hand off", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(() => sessionEntries([]));

    await runHandoff(mockPi, mockCtx, "finish the refactor");

    expect(mockCtx.ui.notify).toHaveBeenCalledWith("No conversation to hand off.", "error");
  });

  it("shows an inline loading modal while the summary is generating", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.sessionManager.getBranch = vi.fn(() => sessionEntries(buildBranch()));
    mockCtx.sessionManager.getSessionFile = vi.fn(() => "/sessions/old.json");
    mockCtx.ui.editor = vi.fn(() => Promise.resolve("edited summary"));

    let modalComponent: { render(width: number): string[] } | undefined;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    mockCtx.ui.custom = mockFn((factory: any) => {
      return new Promise((resolve) => {
        modalComponent = factory(fakeTui(), mockCtx.ui.theme, {}, resolve);
      });
    });

    const { completeSimple } = await import("@earendil-works/pi-ai/compat");
    vi.mocked(completeSimple).mockResolvedValue(
      fauxAssistantMessage([{ type: "text", text: "summary text" }]),
    );

    await runHandoff(mockPi, mockCtx, "finish the refactor");

    expect(modalComponent).toBeDefined();
    const rendered = modalComponent?.render(80).join("\n") ?? "";
    expect(rendered).toContain("Handoff");
    expect(rendered).toContain("Generating summary…");
    expect(mockCtx.ui.setStatus).not.toHaveBeenCalled();
    expect(mockCtx.ui.editor).toHaveBeenCalledWith("Review handoff prompt", "summary text");
  });

  it("prioritizes recent transcript segments when the transcript exceeds the budget", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCustomResolvesOnDone(mockCtx);
    mockCtx.sessionManager.getBranch = vi.fn(() =>
      sessionEntries([
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
      ]),
    );
    mockCtx.ui.editor = vi.fn(() => Promise.resolve(undefined));

    const { completeSimple } = await import("@earendil-works/pi-ai/compat");
    vi.mocked(completeSimple).mockResolvedValue(
      fauxAssistantMessage([{ type: "text", text: "summary text" }]),
    );

    await runHandoff(mockPi, mockCtx, "finish the refactor");

    const request = firstContentText(vi.mocked(completeSimple).mock.calls[0][1].messages[0]) ?? "";
    const transcript = request.match(
      /<conversation_transcript>\n([\s\S]*)\n<\/conversation_transcript>/,
    )?.[1];
    expect(transcript).toBeDefined();
    expect(transcript).toContain("RECENT_MARKER");
    expect(transcript).toContain("MID_BUDGET_MARKER");
    expect(transcript).not.toContain("EARLY_MARKER");
    expect(transcript?.length).toBeLessThanOrEqual(36000);
  });

  it("joins multiple text blocks in one message with newlines", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCustomResolvesOnDone(mockCtx);
    mockCtx.sessionManager.getBranch = vi.fn(() =>
      sessionEntries([
        {
          type: "message",
          message: {
            role: "user",
            content: [
              { type: "text", text: "First part." },
              { type: "text", text: "Second part." },
            ],
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done." }],
          },
        },
      ]),
    );
    mockCtx.ui.editor = vi.fn(() => Promise.resolve(undefined));

    const { completeSimple } = await import("@earendil-works/pi-ai/compat");
    vi.mocked(completeSimple).mockResolvedValue(
      fauxAssistantMessage([{ type: "text", text: "summary text" }]),
    );

    await runHandoff(mockPi, mockCtx, "finish the refactor");

    const request = firstContentText(vi.mocked(completeSimple).mock.calls[0][1].messages[0]) ?? "";
    const transcript = request.match(
      /<conversation_transcript>\n([\s\S]*)\n<\/conversation_transcript>/,
    )?.[1];
    expect(transcript).toContain("User: First part.\nSecond part.");
  });

  it("performs a full handoff with the global small model in UI mode", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCustomResolvesOnDone(mockCtx);
    const activeModel = mockCtx.model;
    const smallModel = createMockModel({
      id: "small-model",
      name: "Small Model",
      provider: "small-provider",
      reasoning: true,
    });
    vi.stubEnv("PI_SMALL_MODEL", "small-provider/small-model");
    mockCtx.modelRegistry.find = vi.fn(() => smallModel);
    mockCtx.sessionManager.getBranch = vi.fn(() => sessionEntries(buildBranch()));
    mockCtx.sessionManager.getSessionFile = vi.fn(() => "/sessions/old.json");
    mockCtx.ui.editor = vi.fn(() => Promise.resolve("edited summary"));

    const { completeSimple } = await import("@earendil-works/pi-ai/compat");
    vi.mocked(completeSimple).mockResolvedValue(
      fauxAssistantMessage([{ type: "text", text: "summary text" }]),
    );

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
    mockCustomResolvesOnDone(mockCtx);
    const replacementCtx = {
      ...createMockCommandContext(),
      sendMessage: vi.fn(),
      sendUserMessage: vi.fn(),
    };
    const setupSessionManager = SessionManager.inMemory();
    vi.spyOn(setupSessionManager, "appendSessionInfo");
    mockCtx.sessionManager.getBranch = vi.fn(() => sessionEntries(buildBranch()));
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

    const { completeSimple } = await import("@earendil-works/pi-ai/compat");
    vi.mocked(completeSimple).mockResolvedValue(
      fauxAssistantMessage([{ type: "text", text: "summary text" }]),
    );

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

  // Pi takes over process.stdout in non-interactive modes and forwards it to
  // stderr, so an extension cannot print the summary to stdout.
  it.each(["print", "json"] as const)(
    "reports that handoff needs an interactive session in %s mode",
    async (mode) => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      mockCtx.hasUI = false;
      mockCtx.mode = mode;
      mockCtx.sessionManager.getBranch = vi.fn(() => sessionEntries(buildBranch()));

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const { completeSimple } = await import("@earendil-works/pi-ai/compat");

      await runHandoff(mockPi, mockCtx, "finish the refactor");

      expect(errorSpy).toHaveBeenCalledWith(
        "handoff needs an interactive session (TUI or RPC mode).",
      );
      expect(logSpy).not.toHaveBeenCalled();
      expect(completeSimple).not.toHaveBeenCalled();
      expect(mockCtx.newSession).not.toHaveBeenCalled();
      expect(mockPi.setSessionName).not.toHaveBeenCalled();

      logSpy.mockRestore();
      errorSpy.mockRestore();
    },
  );

  it("cancels when the editor is dismissed", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCustomResolvesOnDone(mockCtx);
    mockCtx.sessionManager.getBranch = vi.fn(() => sessionEntries(buildBranch()));
    mockCtx.ui.editor = vi.fn(() => Promise.resolve(undefined));

    const { completeSimple } = await import("@earendil-works/pi-ai/compat");
    vi.mocked(completeSimple).mockResolvedValue(
      fauxAssistantMessage([{ type: "text", text: "summary text" }]),
    );

    await runHandoff(mockPi, mockCtx, "finish the refactor");

    expect(mockCtx.ui.notify).toHaveBeenCalledWith("Handoff cancelled.", "info");
    expect(mockCtx.newSession).not.toHaveBeenCalled();
  });

  it("notifies on LLM error and does not create a session", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCustomResolvesOnDone(mockCtx);
    mockCtx.sessionManager.getBranch = vi.fn(() => sessionEntries(buildBranch()));

    const { completeSimple } = await import("@earendil-works/pi-ai/compat");
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
    mockCustomResolvesOnDone(mockCtx);
    mockCtx.sessionManager.getBranch = vi.fn(() => sessionEntries(buildBranch()));

    const { completeSimple } = await import("@earendil-works/pi-ai/compat");
    vi.mocked(completeSimple).mockResolvedValue(fauxAssistantMessage([]));

    await runHandoff(mockPi, mockCtx, "finish the refactor");

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      "Model returned an empty handoff summary.",
      "error",
    );
  });

  describe("non-TUI dialog modes", () => {
    // rpc-mode.js implements ui.custom() as `async custom() { return undefined; }`
    // while hasUI stays true, so the modal must be gated on ctx.mode.
    function mockCtxWithoutCustomModal() {
      const mockCtx = createMockCommandContext();
      mockCtx.mode = "rpc";
      mockCtx.ui.custom = mockFn(async () => undefined);
      mockCtx.sessionManager.getBranch = vi.fn(() => sessionEntries(buildBranch()));
      mockCtx.sessionManager.getSessionFile = vi.fn(() => "/sessions/old.json");
      mockCtx.ui.editor = vi.fn(() => Promise.resolve("edited summary"));
      mockCtx.newSession = vi.fn(() => Promise.resolve({ cancelled: false }));
      return mockCtx;
    }

    it("completes the handoff in RPC mode without the custom modal", async () => {
      const mockPi = createMockPi();
      const mockCtx = mockCtxWithoutCustomModal();

      const { completeSimple } = await import("@earendil-works/pi-ai/compat");
      vi.mocked(completeSimple).mockResolvedValue(
        fauxAssistantMessage([{ type: "text", text: "summary text" }]),
      );

      await expect(runHandoff(mockPi, mockCtx, "finish the refactor")).resolves.toBeUndefined();

      expect(mockCtx.ui.custom).not.toHaveBeenCalled();
      expect(mockCtx.ui.editor).toHaveBeenCalledWith("Review handoff prompt", "summary text");
      expect(mockCtx.newSession).toHaveBeenCalledWith(
        expect.objectContaining({ parentSession: "/sessions/old.json" }),
      );
    });

    it("reports a summary error in RPC mode without throwing", async () => {
      const mockPi = createMockPi();
      const mockCtx = mockCtxWithoutCustomModal();

      const { completeSimple } = await import("@earendil-works/pi-ai/compat");
      vi.mocked(completeSimple).mockRejectedValue(new Error("rate limited"));

      await expect(runHandoff(mockPi, mockCtx, "finish the refactor")).resolves.toBeUndefined();

      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        "Failed to generate handoff summary: rate limited",
        "error",
      );
      expect(mockCtx.ui.editor).not.toHaveBeenCalled();
      expect(mockCtx.newSession).not.toHaveBeenCalled();
    });

    it("treats a missing custom result in TUI mode as a cancellation", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      // A mode that reports hasUI but resolves custom() to undefined.
      mockCtx.ui.custom = mockFn(async () => undefined);
      mockCtx.sessionManager.getBranch = vi.fn(() => sessionEntries(buildBranch()));

      const { completeSimple } = await import("@earendil-works/pi-ai/compat");
      vi.mocked(completeSimple).mockResolvedValue(
        fauxAssistantMessage([{ type: "text", text: "summary text" }]),
      );

      await expect(runHandoff(mockPi, mockCtx, "finish the refactor")).resolves.toBeUndefined();

      expect(mockCtx.ui.notify).toHaveBeenCalledWith("Handoff cancelled.", "info");
      expect(mockCtx.ui.editor).not.toHaveBeenCalled();
      expect(mockCtx.newSession).not.toHaveBeenCalled();
    });
  });

  it("notifies when new session is cancelled", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCustomResolvesOnDone(mockCtx);
    mockCtx.sessionManager.getBranch = vi.fn(() => sessionEntries(buildBranch()));
    mockCtx.sessionManager.getSessionFile = vi.fn(() => "/sessions/old.json");
    mockCtx.ui.editor = vi.fn(() => Promise.resolve("edited summary"));
    mockCtx.newSession = vi.fn(() => Promise.resolve({ cancelled: true }));

    const { completeSimple } = await import("@earendil-works/pi-ai/compat");
    vi.mocked(completeSimple).mockResolvedValue(
      fauxAssistantMessage([{ type: "text", text: "summary text" }]),
    );

    await runHandoff(mockPi, mockCtx, "finish the refactor");

    expect(mockCtx.ui.notify).toHaveBeenCalledWith("New session cancelled.", "info");
  });
});

/**
 * Mock ui.custom so the loading modal's factory runs immediately and the
 * modal promise resolves when the component calls done — i.e. when the
 * pending summary generation settles. dispose is invoked right away so the
 * spinner interval is cleared in tests (it is unref'd in the extension too).
 */
function mockCustomResolvesOnDone(mockCtx: ReturnType<typeof createMockCommandContext>): void {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  mockCtx.ui.custom = mockFn((factory: any) => {
    return new Promise((resolve) => {
      const component = factory(fakeTui(), mockCtx.ui.theme, {}, resolve);
      component?.dispose?.();
    });
  });
}
