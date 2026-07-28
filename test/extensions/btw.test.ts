import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { completeSimple, stream } from "@earendil-works/pi-ai";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import btwExtension from "../../extensions/btw/btw.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { getCommandHandler, getEventHandler } from "../mocks/test-helpers.ts";

vi.mock("@earendil-works/pi-ai", () => ({
  stream: vi.fn(),
  completeSimple: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createReadTool: vi.fn(),
  createBashTool: vi.fn(),
  createEditTool: vi.fn(),
  createWriteTool: vi.fn(),
  getAgentDir: vi.fn(() => "/home/test/.pi/agent"),
}));

// --- Test helpers ---

interface FakeHandle {
  focus: ReturnType<typeof vi.fn>;
  unfocus: ReturnType<typeof vi.fn>;
  isFocused: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  setHidden: ReturnType<typeof vi.fn>;
}

interface CapturedOverlay {
  component: { render: (width: number) => string[]; handleInput?: (data: string) => void };
  done: ReturnType<typeof vi.fn>;
  handle: FakeHandle;
  tui: { requestRender: ReturnType<typeof vi.fn> };
  options: Record<string, unknown>;
}

const THEME = {
  fg: (_c: string, text: string) => text,
  bg: (_c: string, text: string) => text,
  bold: (text: string) => text,
  dim: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strike: (text: string) => text,
};

function assistantMessage(
  content: Array<Record<string, unknown>>,
  stopReason: string,
): Record<string, unknown> {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { total: 0.001 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function makeEventStream(events: Array<Record<string, unknown>>): {
  [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>>;
  result(): Promise<unknown>;
} {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next(): Promise<IteratorResult<Record<string, unknown>>> {
          if (i < events.length) {
            return Promise.resolve({ value: events[i++], done: false });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
    result(): Promise<unknown> {
      const done = events.find((e) => e.type === "done" || e.type === "error");
      return Promise.resolve(done && done.type === "done" ? done.message : done?.error);
    },
  };
}

function textDoneEvents(text: string, partial: Record<string, unknown> = { content: [] }) {
  return [
    { type: "text_start", contentIndex: 0, partial },
    { type: "text_delta", contentIndex: 0, delta: text, partial },
    { type: "text_end", contentIndex: 0, content: text, partial },
    { type: "done", reason: "stop", message: assistantMessage([{ type: "text", text }], "stop") },
  ];
}

function thinkingAndTextDoneEvents(
  thinking: string,
  text: string,
  partial: Record<string, unknown> = { content: [] },
) {
  return [
    { type: "thinking_start", contentIndex: 0, partial },
    { type: "thinking_delta", contentIndex: 0, delta: thinking, partial },
    { type: "thinking_end", contentIndex: 0, content: thinking, partial },
    { type: "text_start", contentIndex: 0, partial },
    { type: "text_delta", contentIndex: 0, delta: text, partial },
    { type: "text_end", contentIndex: 0, content: text, partial },
    {
      type: "done",
      reason: "stop",
      message: assistantMessage(
        [
          { type: "thinking", thinking },
          { type: "text", text },
        ],
        "stop",
      ),
    },
  ];
}

function makeTool(name: string, resultText: string, isError = false) {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: resultText }],
      details: {},
      isError,
    }),
  };
}

function setupTools() {
  const readTool = makeTool("read", "file contents");
  const bashTool = makeTool("bash", "command output");
  const editTool = makeTool("edit", "edited");
  const writeTool = makeTool("write", "wrote");
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  vi.mocked(createReadTool).mockReturnValue(readTool as any);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  vi.mocked(createBashTool).mockReturnValue(bashTool as any);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  vi.mocked(createEditTool).mockReturnValue(editTool as any);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  vi.mocked(createWriteTool).mockReturnValue(writeTool as any);
  return { readTool, bashTool, editTool, writeTool };
}

function setupContext() {
  const overlays: CapturedOverlay[] = [];
  const mockCtx = createMockCommandContext();
  // Destructive commands (reset, inject, summarize) confirm first.
  mockCtx.ui.confirm = vi.fn(() => Promise.resolve(true));
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  mockCtx.ui.custom = vi.fn((factory: any, options?: any) => {
    const handle: FakeHandle = {
      focus: vi.fn(),
      unfocus: vi.fn(),
      isFocused: vi.fn(() => true),
      hide: vi.fn(),
      setHidden: vi.fn(),
    };
    const tui = { requestRender: vi.fn() };
    // biome-ignore lint/suspicious/noConfusingVoidType: matches Promise<void> resolve signature
    let resolveClose: (value?: void) => void;
    const done = vi.fn(() => resolveClose());
    const promise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const component = factory(tui, THEME, null, done);
    if (options?.onHandle) options.onHandle(handle);
    overlays.push({ component, done, handle, tui, options: options ?? {} });
    return promise;
    // biome-ignore lint/suspicious/noExplicitAny: test mock
  }) as any;
  return { mockCtx, overlays };
}

/** Drain the microtask queue enough to settle async fire-and-forget work. */
async function flush() {
  for (let i = 0; i < 200; i++) {
    await Promise.resolve();
  }
}

function getOverlay(overlays: CapturedOverlay[]): CapturedOverlay {
  const overlay = overlays[overlays.length - 1];
  if (!overlay) throw new Error("No overlay was opened");
  return overlay;
}

function registerAll(mockPi: ReturnType<typeof createMockPi>) {
  return btwExtension(mockPi);
}

// --- Tests ---

describe("btw-extension", () => {
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
      const extensionDir = resolve(import.meta.dirname, "../../extensions/btw");
      const rootEntries = await readdir(extensionDir, { withFileTypes: true });
      const rootTypeScriptFiles = rootEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => entry.name);
      const sourceFiles = await readdir(resolve(extensionDir, "src"));

      expect(rootTypeScriptFiles).toEqual(["btw.ts"]);
      expect(sourceFiles.filter((file) => file.endsWith(".ts")).length).toBeGreaterThan(1);
    });
  });

  // §4 Capabilities — registration
  describe("registration", () => {
    it("registers all side-channel commands", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      await registerAll(mockPi);
      const names = mockPi.registerCommand.mock.calls.map((c: unknown[]) => c[0]);
      expect(names).toEqual(
        expect.arrayContaining([
          "btw",
          "btw:new",
          "btw:tangent",
          "btw:reset",
          "btw:inject",
          "btw:summarize",
          "btw:thinking",
        ]),
      );
    });

    it("registers focus-toggle shortcuts (alt+/ and ctrl+alt+w fallback)", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      await registerAll(mockPi);
      const shortcuts = mockPi.registerShortcut.mock.calls.map((c: unknown[]) => c[0]);
      expect(shortcuts).toEqual(expect.arrayContaining(["alt+/", "ctrl+alt+w"]));
    });

    it("registers session_start, session_shutdown, and context handlers", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      await registerAll(mockPi);
      const events = mockPi.on.mock.calls.map((c: unknown[]) => c[0]);
      expect(events).toEqual(
        expect.arrayContaining(["session_start", "session_shutdown", "context"]),
      );
    });
  });

  // §4/§10 — command validation
  describe("command validation", () => {
    it("/btw with no args opens the overlay even when no thread", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx, overlays } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("", mockCtx);
      expect(mockCtx.ui.custom).toHaveBeenCalledTimes(1);
      expect(overlays.length).toBe(1);
    });

    it("/btw with too-long question shows warning", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("x".repeat(2001), mockCtx);
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("too long"),
        "warning",
      );
    });

    it("/btw with no global small model available shows error and does nothing", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx } = setupContext();
      mockCtx.modelRegistry.find = vi.fn(() => undefined);
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("question?", mockCtx);
      await flush();
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Global small model not found"),
        "error",
      );
      expect(stream).not.toHaveBeenCalled();
    });

    it("/btw with no credentials shows error", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx } = setupContext();
      mockCtx.modelRegistry.getApiKeyAndHeaders = vi.fn(async () => ({
        ok: false,
        error: "no key",
      }));
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("question?", mockCtx);
      await flush();
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("No credentials"),
        "error",
      );
    });

    it("/btw:new with no question resets the thread and opens the overlay", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx, overlays } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw:new")("", mockCtx);
      expect(mockCtx.ui.custom).toHaveBeenCalledTimes(1);
      expect(overlays.length).toBe(1);
      expect(mockCtx.ui.notify).toHaveBeenCalledWith("Started a new side thread.", "info");
    });

    it("/btw:tangent with no question resets to tangent and opens the overlay", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx, overlays } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw:tangent")("", mockCtx);
      expect(mockCtx.ui.custom).toHaveBeenCalledTimes(1);
      expect(overlays.length).toBe(1);
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        "Tangent thread started (no main context).",
        "info",
      );
      expect(stream).not.toHaveBeenCalled();
    });
  });

  // §5/§6 — primary flow: real agent loop with streaming
  describe("primary side-question flow", () => {
    beforeEach(() => {
      setupTools();
    });

    it("opens an overlay and streams an answer from the side agent", async () => {
      vi.mocked(stream).mockReturnValue(
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        makeEventStream(textDoneEvents("It is defined in route.ts.")) as any,
      );
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx, overlays } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("where is the route?", mockCtx);
      await flush();

      expect(mockCtx.ui.custom).toHaveBeenCalledTimes(1);
      expect(stream).toHaveBeenCalledTimes(1);
      const [, context] = vi.mocked(stream).mock.calls[0];
      expect(context.systemPrompt).toContain("side-channel agent");
      expect(context.tools).toHaveLength(4);
      const toolNames = (context.tools as Array<{ name: string }>).map((t) => t.name);
      expect(toolNames).toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));

      const rendered = getOverlay(overlays).component.render(80).join("\n");
      expect(rendered).toContain("It is defined in route.ts.");
    });

    it("rebuilds the side prompt with project context and only the side tools", async () => {
      vi.mocked(stream).mockReturnValue(
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        makeEventStream(textDoneEvents("Done.")) as any,
      );
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx } = setupContext();
      mockCtx.getSystemPrompt.mockReturnValue(
        "MAIN AGENT PROMPT\n\nAvailable tools:\n- web_search: Search the web",
      );
      mockCtx.getSystemPromptOptions.mockReturnValue({
        cwd: "/work/project",
        contextFiles: [
          { path: "/home/test/.pi/agent/AGENTS.md", content: "Global agent instructions" },
          { path: "/work/project/AGENTS.md", content: "Project agent instructions" },
        ],
        toolSnippets: {
          read: "Read file contents",
          bash: "Execute shell commands",
          edit: "Edit files using exact text replacements",
          write: "Create or overwrite files",
          web_search: "Search the web",
        },
        skills: [{ name: "unused-skill" }],
      });
      mockCtx.sessionManager.getBranch = vi.fn(() => [
        { type: "message", message: { role: "user", content: "main chat details" } },
      ]);

      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("side question", mockCtx);
      await flush();

      const [, context] = vi.mocked(stream).mock.calls[0];
      const prompt = context.systemPrompt;
      expect(prompt).toContain(
        "You are BTW, a coding assistant operating in a side-channel window inside pi.",
      );
      expect(prompt).toContain("- read: Read file contents");
      expect(prompt).toContain("- bash: Execute shell commands");
      expect(prompt).toContain("- edit: Edit files using exact text replacements");
      expect(prompt).toContain("- write: Create or overwrite files");
      expect(prompt).not.toContain("web_search");
      expect(prompt).not.toContain("MAIN AGENT PROMPT");
      expect(prompt).not.toContain("unused-skill");
      expect(prompt).toContain(
        '<project_instructions path="/home/test/.pi/agent/AGENTS.md">\nGlobal agent instructions',
      );
      expect(prompt).toContain(
        '<project_instructions path="/work/project/AGENTS.md">\nProject agent instructions',
      );
      expect(prompt).toContain("Current working directory: /work/project");
      expect(prompt).toContain("side-channel agent");
      expect(prompt).toContain("main chat details");
    });

    it("reflects streaming deltas into the transcript before completion", async () => {
      // Hand-build a stream that pauses mid-delta so we can observe the partial.
      let resolveDone: () => void = () => {};
      const events: Array<Record<string, unknown>> = [
        { type: "text_start", contentIndex: 0, partial: { content: [] } },
        { type: "text_delta", contentIndex: 0, delta: "partial answer", partial: { content: [] } },
      ];
      const eventStream = {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            next: () => {
              if (i < events.length) return Promise.resolve({ value: events[i++], done: false });
              return new Promise<IteratorResult<Record<string, unknown>>>((res) => {
                resolveDone = () =>
                  res({
                    value: {
                      type: "done",
                      reason: "stop",
                      message: assistantMessage(
                        [{ type: "text", text: "partial answer done" }],
                        "stop",
                      ),
                    },
                    done: false,
                  });
              });
            },
          };
        },
        result: () => Promise.resolve(),
      };
      // Push a terminal event after the deltas are consumed.
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      vi.mocked(stream).mockReturnValue(eventStream as any);
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx, overlays } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("q?", mockCtx);
      await flush();

      const partial = getOverlay(overlays).component.render(80).join("\n");
      expect(partial).toContain("partial answer");
      // A streaming marker is shown on the in-progress answer.
      expect(partial).toContain("▌");

      resolveDone();
      await flush();
    });

    it("executes tool calls between turns and shows their results", async () => {
      vi.mocked(stream)
        .mockReturnValueOnce(
          makeEventStream([
            {
              type: "toolcall_start",
              contentIndex: 0,
              partial: assistantMessage(
                [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
                "toolUse",
              ),
            },
            {
              type: "toolcall_end",
              contentIndex: 0,
              toolCall: { type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
              partial: { content: [] },
            },
            {
              type: "done",
              reason: "toolUse",
              message: assistantMessage(
                [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
                "toolUse",
              ),
            },
            // biome-ignore lint/suspicious/noExplicitAny: test mock
          ]) as any,
        )
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        .mockReturnValueOnce(makeEventStream(textDoneEvents("Found it.")) as any);

      const { readTool } = setupTools();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx, overlays } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("what is in a.ts?", mockCtx);
      await flush();

      expect(readTool.execute).toHaveBeenCalledWith(
        "tc1",
        { path: "a.ts" },
        expect.any(AbortSignal),
      );
      expect(stream).toHaveBeenCalledTimes(2);
      const rendered = getOverlay(overlays).component.render(80).join("\n");
      expect(rendered).toContain("file contents");
      expect(rendered).toContain("Found it.");
    });

    it("persist each exchange as hidden session state", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      vi.mocked(stream).mockReturnValue(makeEventStream(textDoneEvents("answer")) as any);
      setupTools();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("q?", mockCtx);
      await flush();
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        "btw-thread",
        expect.objectContaining({ state: expect.any(Object) }),
      );
    });
  });

  // §6 — contextual vs tangent modes
  describe("modes", () => {
    beforeEach(() => {
      setupTools();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      vi.mocked(stream).mockReturnValue(makeEventStream(textDoneEvents("ok")) as any);
    });

    it("contextual mode seeds the side agent with main-session background", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx } = setupContext();
      mockCtx.sessionManager.getBranch = vi.fn(() => [
        { type: "message", message: { role: "user", content: "fix the login bug" } },
      ]);
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("what is the login bug?", mockCtx);
      await flush();
      const [, context] = vi.mocked(stream).mock.calls[0];
      expect(context.systemPrompt).toContain("fix the login bug");
      expect(context.systemPrompt).toContain("<main_session_background>");
    });

    it("tangent mode omits main-session background and flags the title", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx, overlays } = setupContext();
      mockCtx.sessionManager.getBranch = vi.fn(() => [
        { type: "message", message: { role: "user", content: "secret main work" } },
      ]);
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw:tangent")("a clean-slate question?", mockCtx);
      await flush();
      const [, context] = vi.mocked(stream).mock.calls[0];
      expect(context.systemPrompt).not.toContain("secret main work");
      expect(context.systemPrompt).not.toContain("<main_session_background>");
      const rendered = getOverlay(overlays).component.render(80).join("\n");
      expect(rendered).toContain("tangent");
    });

    it("switching to tangent clears any existing contextual thread", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("ctx question?", mockCtx);
      await flush();
      expect(mockPi.appendEntry).toHaveBeenCalledWith("btw-thread", expect.any(Object));

      await getCommandHandler(mockPi, "btw:tangent")("tangent question?", mockCtx);
      await flush();
      // The thread was cleared before the tangent started: the old contextual
      // question is gone, only the tangent exchange remains.
      const calls = mockPi.appendEntry.mock.calls.filter((c: unknown[]) => c[0] === "btw-thread");
      const lastState = calls[calls.length - 1]?.[1] as {
        state: { messages: Array<{ role: string; content: unknown }> };
      };
      const allContent = lastState.state.messages
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join(" ");
      expect(allContent).not.toContain("ctx question");
      expect(allContent).toContain("tangent question");
    });
  });

  // §4/§5/§10 — handoff
  describe("handoff", () => {
    beforeEach(() => {
      setupTools();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      vi.mocked(stream).mockReturnValue(makeEventStream(textDoneEvents("side answer")) as any);
    });

    it("/btw:inject on an empty thread warns and does nothing", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw:inject")("", mockCtx);
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Nothing to hand off"),
        "warning",
      );
      expect(mockPi.sendUserMessage).not.toHaveBeenCalled();
    });

    it("/btw:inject sends the full thread to the main agent and clears it", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("what is 2+2?", mockCtx);
      await flush();
      mockPi.sendUserMessage.mockClear();
      mockCtx.ui.confirm = vi.fn(() => Promise.resolve(false));

      await getCommandHandler(mockPi, "btw:inject")("", mockCtx);
      await flush();

      expect(mockPi.sendUserMessage).not.toHaveBeenCalled();

      mockCtx.ui.confirm = vi.fn(() => Promise.resolve(true));
      await getCommandHandler(mockPi, "btw:inject")("", mockCtx);
      await flush();

      expect(mockPi.sendUserMessage).toHaveBeenCalledTimes(1);
      const [content] = mockPi.sendUserMessage.mock.calls[0];
      expect(content).toContain("From a side conversation (full thread");
      expect(content).toContain("what is 2+2?");
      expect(content).toContain("side answer");
      // Thread cleared after handoff.
      const calls = mockPi.appendEntry.mock.calls.filter((c: unknown[]) => c[0] === "btw-thread");
      const last = calls[calls.length - 1]?.[1] as { state: { messages: unknown[] } };
      expect(last.state.messages).toHaveLength(0);
    });

    it("/btw:inject while main agent is busy queues as a follow-up", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("q?", mockCtx);
      await flush();

      mockCtx.isIdle = vi.fn(() => false);
      await getCommandHandler(mockPi, "btw:inject")("", mockCtx);
      await flush();

      expect(mockPi.sendUserMessage).toHaveBeenCalledWith(expect.any(String), {
        deliverAs: "followUp",
      });
    });

    it("/btw:summarize on an empty thread warns", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw:summarize")("", mockCtx);
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Nothing to hand off"),
        "warning",
      );
    });

    it("/btw:summarize distills the thread with thinking off and sends it", async () => {
      vi.mocked(completeSimple).mockResolvedValue({
        content: [{ type: "text", text: "- Decision: use option A\n- Risk: cost" }],
        // biome-ignore lint/suspicious/noExplicitAny: test mock
      } as any);
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx } = setupContext();
      const smallModel = {
        ...mockCtx.model,
        id: "small-model",
        provider: "small-provider",
        reasoning: true,
      };
      vi.stubEnv("PI_SMALL_MODEL", "small-provider/small-model");
      mockCtx.modelRegistry.find = vi.fn(() => smallModel);
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("should we use A or B?", mockCtx);
      await flush();

      await getCommandHandler(mockPi, "btw:summarize")("", mockCtx);
      await flush();

      expect(completeSimple).toHaveBeenCalledTimes(1);
      const [summaryModel, , options] = vi.mocked(completeSimple).mock.calls[0];
      expect(summaryModel).toBe(smallModel);
      // Summarization always runs with thinking off (minimal).
      expect(options).toMatchObject({ reasoning: "minimal" });
      const [content] =
        mockPi.sendUserMessage.mock.calls[mockPi.sendUserMessage.mock.calls.length - 1];
      expect(content).toContain("Decision: use option A");
    });
  });

  describe("global small model", () => {
    it("uses the global small model instead of the active main model", async () => {
      setupTools();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      vi.mocked(stream).mockReturnValue(makeEventStream(textDoneEvents("small says hi")) as any);
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx } = setupContext();
      const activeModel = mockCtx.model;
      const smallModel = {
        ...activeModel,
        id: "small-model",
        provider: "small-provider",
        reasoning: true,
      };
      vi.stubEnv("PI_SMALL_MODEL", "small-provider/small-model");
      mockCtx.modelRegistry.find = vi.fn(() => smallModel);
      await registerAll(mockPi);

      await getCommandHandler(mockPi, "btw")("hi?", mockCtx);
      await flush();

      const [usedModel, , options] = vi.mocked(stream).mock.calls[0];
      expect(usedModel).toBe(smallModel);
      expect(options).toMatchObject({ apiKey: "test-key", reasoning: "minimal" });
      expect(usedModel).not.toBe(activeModel);
    });

    it("does not register a side-specific model command", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      await registerAll(mockPi);

      const commands = mockPi.registerCommand.mock.calls.map((call: unknown[]) => call[0]);
      expect(commands).not.toContain("btw:model");
    });
  });

  // §4 — thinking override
  describe("thinking override", () => {
    it("/btw:thinking shows the inherited level by default", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw:thinking")("", mockCtx);
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("inherit"), "info");
    });

    it("/btw:thinking medium sets the override", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw:thinking")("medium", mockCtx);
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("medium"), "info");
    });

    it("/btw:thinking with an invalid level shows usage", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw:thinking")("max", mockCtx);
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Unknown thinking level"),
        "error",
      );
    });

    it("/btw:thinking clear resets the override", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw:thinking")("high", mockCtx);
      await getCommandHandler(mockPi, "btw:thinking")("clear", mockCtx);
      expect(mockCtx.ui.notify).toHaveBeenLastCalledWith(
        expect.stringContaining("cleared"),
        "info",
      );
    });
  });

  // §4/§10 — reset
  describe("reset", () => {
    it("/btw:reset with nothing shows info", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw:reset")("", mockCtx);
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("No side thread to reset"),
        "info",
      );
    });

    it("/btw:reset clears the thread, closes the overlay, and notifies", async () => {
      setupTools();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      vi.mocked(stream).mockReturnValue(makeEventStream(textDoneEvents("ans")) as any);
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx, overlays } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("q?", mockCtx);
      await flush();
      const overlay = getOverlay(overlays);

      await getCommandHandler(mockPi, "btw:reset")("", mockCtx);

      expect(overlay.done).toHaveBeenCalled();
      expect(mockCtx.ui.notify).toHaveBeenCalledWith("Side thread reset.", "info");
    });
  });

  // §6/§10 — persistence & reconstruction
  describe("persistence and reconstruction", () => {
    it("reconstructs the thread and ignores a legacy model override on session_start", async () => {
      setupTools();
      const persistedState = {
        mode: "tangent",
        messages: [
          { role: "user", content: "old question", timestamp: 1 },
          {
            role: "assistant",
            content: [{ type: "text", text: "old answer" }],
            stopReason: "stop",
            usage: { totalTokens: 5 },
            timestamp: 2,
            // biome-ignore lint/suspicious/noExplicitAny: test mock
          } as any,
        ],
        modelOverride: { provider: "anthropic", id: "haiku", api: "anthropic-messages" },
        thinkingOverride: "low",
      };
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx, overlays } = setupContext();
      mockCtx.sessionManager.getBranch = vi.fn(() => [
        { type: "custom", customType: "btw-thread", data: { state: persistedState } },
      ]);
      await registerAll(mockPi);
      const handler = getEventHandler(mockPi, "session_start");
      await handler({ type: "session_start", reason: "resume" }, mockCtx);

      // Reopening should show the reconstructed thread.
      await getCommandHandler(mockPi, "btw")("", mockCtx);
      const rendered = getOverlay(overlays).component.render(80).join("\n");
      expect(rendered).toContain("old question");
      expect(rendered).toContain("old answer");
      expect(rendered).toContain("tangent");
      expect(rendered).toContain("test-provider/test-model");

      await getCommandHandler(mockPi, "btw:thinking")("medium", mockCtx);
      const persisted = mockPi.appendEntry.mock.calls.at(-1)?.[1] as Record<string, unknown>;
      expect(JSON.stringify(persisted)).not.toContain("modelOverride");
    });
  });

  // §8/§12 — context isolation
  describe("context isolation", () => {
    it("filters side-thread entries out of the main agent context", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx } = setupContext();
      await registerAll(mockPi);
      const handler = getEventHandler(mockPi, "context");
      const messages = [
        { role: "user", content: "real work" },
        { customType: "btw-thread", content: "thread" },
        { role: "assistant", content: "ok" },
      ];
      const result = await handler({ type: "context", messages }, mockCtx);
      expect(result).toEqual({
        messages: [
          { role: "user", content: "real work" },
          { role: "assistant", content: "ok" },
        ],
      });
    });

    it("returns undefined when nothing needs filtering", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx } = setupContext();
      await registerAll(mockPi);
      const handler = getEventHandler(mockPi, "context");
      const messages = [{ role: "user", content: "x" }];
      const result = await handler({ type: "context", messages }, mockCtx);
      expect(result).toBeUndefined();
    });
  });

  // §10 — abort and failure
  describe("abort and failure", () => {
    it("removes the in-progress turn on abort and notes the abort status", async () => {
      setupTools();
      vi.mocked(stream).mockReturnValue(
        makeEventStream([
          { type: "text_start", contentIndex: 0, partial: { content: [] } },
          {
            type: "text_delta",
            contentIndex: 0,
            delta: "half an answer",
            partial: { content: [] },
          },
          {
            type: "error",
            reason: "aborted",
            error: assistantMessage([], "aborted"),
          },
          // biome-ignore lint/suspicious/noExplicitAny: test mock
        ]) as any,
      );
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx, overlays } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("q?", mockCtx);
      await flush();
      const rendered = getOverlay(overlays).component.render(80).join("\n");
      expect(rendered).not.toContain("half an answer");
      expect(rendered).toContain("aborted");
    });

    it("writes failure into the transcript and preserves the thread on error", async () => {
      setupTools();
      vi.mocked(stream).mockReturnValue(
        makeEventStream([
          {
            type: "error",
            reason: "error",
            error: { ...assistantMessage([], "error"), errorMessage: "rate limited" },
          },
          // biome-ignore lint/suspicious/noExplicitAny: test mock
        ]) as any,
      );
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx, overlays } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("q?", mockCtx);
      await flush();
      const rendered = getOverlay(overlays).component.render(80).join("\n");
      expect(rendered).toContain("rate limited");
      // The user question is preserved.
      expect(rendered).toContain("q?");
    });
  });

  // §6 — lifecycle teardown
  describe("lifecycle", () => {
    it("session_shutdown closes any open overlay", async () => {
      setupTools();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      vi.mocked(stream).mockReturnValue(makeEventStream(textDoneEvents("ans")) as any);
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx, overlays } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("q?", mockCtx);
      await flush();
      const overlay = getOverlay(overlays);
      await getEventHandler(mockPi, "session_shutdown")(
        { type: "session_shutdown", reason: "quit" },
        mockCtx,
      );
      expect(overlay.done).toHaveBeenCalled();
    });
  });

  // §7 — overlay interaction
  describe("overlay interaction", () => {
    beforeEach(() => {
      setupTools();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      vi.mocked(stream).mockReturnValue(makeEventStream(textDoneEvents("ans")) as any);
    });

    it("Esc closes the overlay without clearing the thread", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx, overlays } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("q?", mockCtx);
      await flush();
      const overlay = getOverlay(overlays);
      overlay.component.handleInput?.("\x1b");
      expect(overlay.done).toHaveBeenCalled();
      // Thread survives Esc — reopening shows it again.
      await getCommandHandler(mockPi, "btw")("", mockCtx);
      const reopened = getOverlay(overlays);
      expect(reopened.component.render(80).join("\n")).toContain("q?");
    });

    it("Enter submits the composer as a follow-up question", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx, overlays } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("first?", mockCtx);
      await flush();
      const overlay = getOverlay(overlays);

      // Type a follow-up and submit.
      for (const ch of "second?") overlay.component.handleInput?.(ch);
      overlay.component.handleInput?.("\r");
      await flush();

      expect(stream).toHaveBeenCalledTimes(2);
    });

    it("Alt+/ toggles focus via the overlay handle", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx, overlays } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("q?", mockCtx);
      await flush();
      const handle = getOverlay(overlays).handle;
      handle.isFocused.mockReturnValue(true);

      const shortcutCall = mockPi.registerShortcut.mock.calls.find(
        (c: unknown[]) => c[0] === "alt+/",
      );
      await shortcutCall?.[1].handler(mockCtx);
      expect(handle.unfocus).toHaveBeenCalled();

      handle.isFocused.mockReturnValue(false);
      await shortcutCall?.[1].handler(mockCtx);
      expect(handle.focus).toHaveBeenCalled();
    });

    it("renders mode title, exchange count, transcript badges, composer, and hints", async () => {
      vi.mocked(stream)
        .mockReturnValueOnce(
          makeEventStream([
            {
              type: "toolcall_end",
              contentIndex: 0,
              toolCall: { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } },
              partial: { content: [] },
            },
            {
              type: "done",
              reason: "toolUse",
              message: assistantMessage(
                [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } }],
                "toolUse",
              ),
            },
            // biome-ignore lint/suspicious/noExplicitAny: test mock
          ]) as any,
        )
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        .mockReturnValueOnce(makeEventStream(textDoneEvents("all set")) as any);
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx, overlays } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("list files?", mockCtx);
      await flush();
      const rendered = getOverlay(overlays).component.render(90).join("\n");
      expect(rendered).toContain("BTW");
      expect(rendered).toContain("contextual");
      expect(rendered).toContain("test-provider/test-model");
      expect(rendered).toContain("thinking minimal");
      expect(rendered).toContain("1 exchange");
      expect(rendered).toContain("command output");
      expect(rendered).toContain("all set");
      expect(rendered).toContain("enter");
      expect(rendered).toContain("alt+/");
    });

    it("shows the tangent mode label in the config line", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      vi.mocked(stream).mockReturnValue(makeEventStream(textDoneEvents("ans")) as any);
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx, overlays } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw:tangent")("q?", mockCtx);
      await flush();
      const rendered = getOverlay(overlays).component.render(90).join("\n");
      expect(rendered).toContain("tangent");
      expect(rendered).not.toContain("contextual");
    });

    it("shows the global small model and side thinking override in the config line", async () => {
      setupTools();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      vi.mocked(stream).mockReturnValue(makeEventStream(textDoneEvents("ans")) as any);
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx, overlays } = setupContext();
      const smallModel = {
        ...mockCtx.model,
        id: "small-model",
        provider: "small-provider",
        reasoning: true,
      };
      vi.stubEnv("PI_SMALL_MODEL", "small-provider/small-model");
      mockCtx.modelRegistry.find = vi.fn(() => smallModel);
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw:thinking")("high", mockCtx);
      await getCommandHandler(mockPi, "btw")("q?", mockCtx);
      await flush();
      const rendered = getOverlay(overlays).component.render(90).join("\n");
      expect(rendered).toContain("small-provider/small-model");
      expect(rendered).toContain("thinking high");
    });
  });

  // multi-turn conversation memory
  describe("multi-turn history", () => {
    beforeEach(() => {
      setupTools();
    });

    it("carries prior side-thread exchanges into follow-up turns", async () => {
      vi.mocked(stream)
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        .mockReturnValueOnce(makeEventStream(textDoneEvents("first answer")) as any)
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        .mockReturnValueOnce(makeEventStream(textDoneEvents("second answer")) as any);
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("first question", mockCtx);
      await flush();
      await getCommandHandler(mockPi, "btw")("second question", mockCtx);
      await flush();

      expect(stream).toHaveBeenCalledTimes(2);
      const secondMessages = vi.mocked(stream).mock.calls[1][1].messages;
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const roles = secondMessages.map((m: any) => m.role);
      // History from the first exchange precedes the new question.
      expect(roles).toEqual(["user", "assistant", "user"]);
      expect(secondMessages[0].content[0].text).toBe("first question");
    });

    it("includes the assistant tool-call message before its tool results in multi-step turns", async () => {
      vi.mocked(stream)
        .mockReturnValueOnce(
          makeEventStream([
            {
              type: "toolcall_end",
              contentIndex: 0,
              toolCall: {
                type: "toolCall",
                id: "tc1",
                name: "read",
                arguments: { path: "a.ts" },
              },
              partial: { content: [] },
            },
            {
              type: "done",
              reason: "toolUse",
              message: assistantMessage(
                [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
                "toolUse",
              ),
            },
            // biome-ignore lint/suspicious/noExplicitAny: test mock
          ]) as any,
        )
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        .mockReturnValueOnce(makeEventStream(textDoneEvents("all done")) as any);
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("q?", mockCtx);
      await flush();

      expect(stream).toHaveBeenCalledTimes(2);
      const secondMessages = vi.mocked(stream).mock.calls[1][1].messages;
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const roles = secondMessages.map((m: any) => m.role);
      // The assistant message that requested the tool must precede its result.
      expect(roles).toEqual(["user", "assistant", "toolResult"]);
    });

    it("keeps each turn's thinking in its own block across turns", async () => {
      vi.mocked(stream)
        .mockReturnValueOnce(
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          makeEventStream(thinkingAndTextDoneEvents("first thought", "first answer")) as any,
        )
        .mockReturnValueOnce(
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          makeEventStream(thinkingAndTextDoneEvents("second thought", "second answer")) as any,
        );
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx, overlays } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("first?", mockCtx);
      await flush();
      await getCommandHandler(mockPi, "btw")("second?", mockCtx);
      await flush();

      const rendered = getOverlay(overlays).component.render(80).join("\n");
      // Both thinking blocks survive on their own — turn 2's thinking must
      // not have been appended onto turn 1's entry.
      expect(rendered).not.toContain("first thoughtsecond thought");
      const thinkingLines = rendered.split("\n").filter((l) => l.includes("↳ thinking:"));
      expect(thinkingLines).toHaveLength(2);
      expect(thinkingLines[0]).toContain("first thought");
      expect(thinkingLines[1]).toContain("second thought");
      // And the answers land under the right turn.
      expect(rendered).toContain("first answer");
      expect(rendered).toContain("second answer");
    });

    it("renders a turn's thinking above its answer", async () => {
      vi.mocked(stream).mockReturnValueOnce(
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        makeEventStream(thinkingAndTextDoneEvents("the reasoning", "the answer")) as any,
      );
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx, overlays } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("q?", mockCtx);
      await flush();

      const rendered = getOverlay(overlays).component.render(80).join("\n");
      expect(rendered.indexOf("the reasoning")).toBeLessThan(rendered.indexOf("the answer"));
    });
  });

  // queued turns while a side turn is streaming
  describe("concurrency", () => {
    beforeEach(() => {
      setupTools();
    });

    it("queues a second question while one is streaming and runs it after", async () => {
      const release = { fn: null as null | (() => void) };
      const events: Array<Record<string, unknown>> = [];
      const blockingStream = {
        [Symbol.asyncIterator]() {
          let i = 0;
          let released = false;
          return {
            next: () => {
              if (i < events.length) {
                return Promise.resolve({ value: events[i++], done: false });
              }
              if (!released) {
                return new Promise<IteratorResult<Record<string, unknown>>>((res) => {
                  release.fn = () => {
                    released = true;
                    res({
                      value: {
                        type: "done",
                        reason: "stop",
                        message: assistantMessage([{ type: "text", text: "first answer" }], "stop"),
                      },
                      done: false,
                    });
                  };
                });
              }
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
        result: () => Promise.resolve(),
      };
      vi.mocked(stream)
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        .mockReturnValueOnce(blockingStream as any)
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        .mockReturnValueOnce(makeEventStream(textDoneEvents("second answer")) as any);

      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const mockPi = createMockPi() as any;
      const { mockCtx, overlays } = setupContext();
      await registerAll(mockPi);
      await getCommandHandler(mockPi, "btw")("first?", mockCtx);
      await flush();

      // First turn is mid-stream: a second question must queue, not race it.
      await getCommandHandler(mockPi, "btw")("second?", mockCtx);
      await flush();
      expect(stream).toHaveBeenCalledTimes(1);
      expect(getOverlay(overlays).component.render(80).join("\n")).toContain("queued");

      // Releasing the first turn drains the queue and runs the second.
      release.fn?.();
      await flush();
      expect(stream).toHaveBeenCalledTimes(2);
    });
  });
});
