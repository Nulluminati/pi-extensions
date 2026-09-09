import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import gondolinExtension from "../../extensions/gondolin/gondolin.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";
import { getCommandHandler, getEventHandler } from "../mocks/test-helpers.ts";

const mockVm = {
  id: "test-vm-id",
  fs: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    access: vi.fn(),
    stat: vi.fn(),
    listDir: vi.fn(),
  },
  exec: vi.fn(() =>
    Promise.resolve({
      exitCode: 0,
      stdout: "bash",
      stderr: "",
      ok: true,
    }),
  ),
  close: vi.fn(),
};

vi.mock("@earendil-works/gondolin", () => ({
  VM: {
    create: vi.fn(() => Promise.resolve(mockVm)),
  },
  RealFSProvider: vi.fn(),
  ReadonlyProvider: vi.fn(),
  MemoryProvider: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createReadTool: vi.fn(() => ({ name: "read", execute: vi.fn() })),
  createWriteTool: vi.fn(() => ({ name: "write", execute: vi.fn() })),
  createEditTool: vi.fn(() => ({ name: "edit", execute: vi.fn() })),
  createBashTool: vi.fn(() => ({ name: "bash", execute: vi.fn() })),
  createGrepTool: vi.fn(() => ({ name: "grep", execute: vi.fn() })),
  createFindTool: vi.fn(() => ({ name: "find", execute: vi.fn() })),
  createLsTool: vi.fn(() => ({ name: "ls", execute: vi.fn() })),
  DEFAULT_MAX_BYTES: 100000,
  formatSize: vi.fn((bytes: number) => `${bytes}B`),
  truncateHead: vi.fn((text: string) => ({ content: text, truncated: false })),
  truncateLine: vi.fn((line: string) => ({ text: line, wasTruncated: false })),
}));

describe("gondolin-extension", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("file structure", () => {
    it("keeps one discoverable entrypoint and implementation modules under src", async () => {
      const extensionDir = resolve(import.meta.dirname, "../../extensions/gondolin");
      const rootEntries = await readdir(extensionDir, { withFileTypes: true });
      const rootTypeScriptFiles = rootEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => entry.name);
      const sourceFiles = await readdir(resolve(extensionDir, "src"));

      expect(rootTypeScriptFiles).toEqual(["gondolin.ts"]);
      expect(sourceFiles.filter((file) => file.endsWith(".ts"))).toHaveLength(6);
    });
  });

  it("registers the gondolin flag", async () => {
    const mockPi = createMockPi();
    await gondolinExtension(mockPi);
    expect(mockPi.registerFlag).toHaveBeenCalledWith(
      "gondolin",
      expect.objectContaining({
        description: expect.stringContaining("Gondolin"),
        type: "boolean",
        default: false,
      }),
    );
  });

  it("gondolin prereqs reject Node < 23.6 and accept newer", async () => {
    const { assertGondolinPrereqs } = await import("../../extensions/gondolin/gondolin.ts");
    expect(() => assertGondolinPrereqs("22.5.0")).toThrow(/23\.6\.0/);
    expect(() => assertGondolinPrereqs("23.5.9")).toThrow(/23\.6\.0/);
    expect(() => assertGondolinPrereqs("23.6.0")).not.toThrow();
    expect(() => assertGondolinPrereqs("24.1.2")).not.toThrow();
  });

  it("a failed VM startup errors tool calls with QEMU guidance instead of host fallback", async () => {
    const mockPi = createMockPi();
    await gondolinExtension(mockPi);
    mockPi.getFlag = vi.fn(() => true);
    const { VM } = (await import("@earendil-works/gondolin")) as unknown as {
      VM: { create: ReturnType<typeof vi.fn> };
    };
    VM.create.mockRejectedValue(new Error("qemu-system-x86_64: not found"));

    const ctx = createMockCommandContext();
    const sessionStart = getEventHandler(mockPi, "session_start");
    await expect(sessionStart({ type: "session_start", reason: "startup" }, ctx)).rejects.toThrow(
      /Gondolin VM failed to start/,
    );

    // Every tool call now fails loudly with the QEMU hint — never silently
    // running against the host filesystem.
    const tools = mockPi.registerTool.mock.calls.map((call) => call[0]);
    const readTool = tools.find((tool) => tool.name === "read");
    await expect(readTool.execute("id", { path: "x" }, undefined, undefined, ctx)).rejects.toThrow(
      /QEMU/,
    );
  });

  it("starts the VM headlessly without touching a missing UI", async () => {
    const mockPi = createMockPi();
    await gondolinExtension(mockPi);
    mockPi.getFlag = vi.fn(() => true);
    const { VM } = (await import("@earendil-works/gondolin")) as unknown as {
      VM: { create: ReturnType<typeof vi.fn> };
    };
    VM.create.mockImplementation(() => Promise.resolve(mockVm));

    const ctx = createMockCommandContext();
    ctx.hasUI = false;

    const sessionStart = getEventHandler(mockPi, "session_start");
    await expect(
      sessionStart({ type: "session_start", reason: "startup" }, ctx),
    ).resolves.toBeUndefined();
    expect(VM.create).toHaveBeenCalled();
  });

  it("when disabled, registers tools and handlers but does not start VM", async () => {
    const mockPi = createMockPi();
    mockPi.getFlag = vi.fn(() => false);
    await gondolinExtension(mockPi);
    expect(mockPi.registerCommand).toHaveBeenCalledTimes(1);
    expect(mockPi.registerTool).toHaveBeenCalledTimes(7);
    expect(mockPi.on).toHaveBeenCalledTimes(4);
  });

  it("when disabled, /gondolin command reports not running", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockPi.getFlag = vi.fn(() => false);
    await gondolinExtension(mockPi);

    const handler = getCommandHandler(mockPi, "gondolin");
    await handler("", mockCtx);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("not running"), "info");
  });

  it("/gondolin command does nothing in non-UI mode", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockCtx.hasUI = false;
    mockPi.getFlag = vi.fn(() => false);
    await gondolinExtension(mockPi);

    const handler = getCommandHandler(mockPi, "gondolin");
    await handler("", mockCtx);

    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });

  it("when disabled, session_start does not start the VM", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockPi.getFlag = vi.fn(() => false);
    await gondolinExtension(mockPi);

    const sessionStart = getEventHandler(mockPi, "session_start");
    await sessionStart({ type: "session_start", reason: "new" }, mockCtx);

    expect(mockCtx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("when disabled, before_agent_start does not modify system prompt", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockPi.getFlag = vi.fn(() => false);
    await gondolinExtension(mockPi);

    const beforeAgentStart = getEventHandler(mockPi, "before_agent_start");
    const result = await beforeAgentStart(
      {
        type: "before_agent_start",
        systemPrompt: "Current working directory: /home/user/project",
      },
      mockCtx,
    );

    expect(result).toBeUndefined();
  });

  it("when disabled, tools use local operations", async () => {
    const { createReadTool } = await import("@earendil-works/pi-coding-agent");
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockPi.getFlag = vi.fn(() => false);
    await gondolinExtension(mockPi);

    const readTool = getToolByName(mockPi, "read");
    expect(readTool).toBeDefined();
    await readTool.execute("tc-1", { filePath: "test.txt" }, undefined, vi.fn(), mockCtx);

    expect(createReadTool).not.toHaveBeenCalledWith("/workspace", expect.anything());
  });

  it("when disabled, user_bash returns undefined", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockPi.getFlag = vi.fn(() => false);
    await gondolinExtension(mockPi);

    const userBash = getEventHandler(mockPi, "user_bash");
    const result = await userBash(
      {
        type: "user_bash",
        command: "ls",
        excludeFromContext: false,
        cwd: "/home/user/project",
      },
      mockCtx,
    );

    expect(result).toBeUndefined();
  });

  it("registers /gondolin command", async () => {
    const mockPi = createMockPi();
    mockPi.getFlag = vi.fn(() => true);
    await gondolinExtension(mockPi);
    expect(mockPi.registerCommand).toHaveBeenCalledWith(
      "gondolin",
      expect.objectContaining({
        description: expect.stringContaining("VM status"),
        handler: expect.any(Function),
      }),
    );
  });

  it("registers all 7 tools when enabled", async () => {
    const mockPi = createMockPi();
    mockPi.getFlag = vi.fn(() => true);
    await gondolinExtension(mockPi);
    expect(mockPi.registerTool).toHaveBeenCalledTimes(7);
  });

  it("registers event handlers for session_start, session_shutdown, user_bash, before_agent_start when enabled", async () => {
    const mockPi = createMockPi();
    mockPi.getFlag = vi.fn(() => true);
    await gondolinExtension(mockPi);
    const events = mockPi.on.mock.calls.map((call) => call[0]);
    expect(events).toContain("session_start");
    expect(events).toContain("session_shutdown");
    expect(events).toContain("user_bash");
    expect(events).toContain("before_agent_start");
  });

  it("session_start handler starts the VM", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockPi.getFlag = vi.fn(() => true);
    await gondolinExtension(mockPi);

    const sessionStart = getEventHandler(mockPi, "session_start");
    await sessionStart({ type: "session_start", reason: "new" }, mockCtx);

    expect(mockCtx.ui.setStatus).toHaveBeenCalledWith(
      "gondolin",
      expect.stringContaining("starting"),
    );
    // VM state changes are also published on the event bus so the status bar
    // can render the workspace segment on line 1.
    expect(mockPi.events.emit).toHaveBeenCalledWith("gondolin:vm-state", { state: "starting" });
    expect(mockPi.events.emit).toHaveBeenCalledWith("gondolin:vm-state", {
      state: "ready",
      vmId: "test-vm-id",
    });
  });

  it("session_shutdown handler stops the VM", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockPi.getFlag = vi.fn(() => true);
    await gondolinExtension(mockPi);

    const sessionStart = getEventHandler(mockPi, "session_start");
    await sessionStart({ type: "session_start", reason: "new" }, mockCtx);

    const sessionShutdown = getEventHandler(mockPi, "session_shutdown");
    await sessionShutdown({ type: "session_shutdown", reason: "user_request" }, mockCtx);

    expect(mockVm.close).toHaveBeenCalled();
    expect(mockPi.events.emit).toHaveBeenCalledWith("gondolin:vm-state", { state: "stopping" });
    expect(mockPi.events.emit).toHaveBeenCalledWith("gondolin:vm-state", { state: "stopped" });
  });

  it("before_agent_start handler patches system prompt", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockPi.getFlag = vi.fn(() => true);
    await gondolinExtension(mockPi);

    const sessionStart = getEventHandler(mockPi, "session_start");
    await sessionStart({ type: "session_start", reason: "new" }, mockCtx);

    const beforeAgentStart = getEventHandler(mockPi, "before_agent_start");
    const result = (await beforeAgentStart(
      {
        type: "before_agent_start",
        systemPrompt: "Current working directory: /home/user/project",
      },
      mockCtx,
    )) as { systemPrompt: string };

    expect(result.systemPrompt).toContain("/workspace");
    expect(result.systemPrompt).toContain("Gondolin VM");
  });

  it("/gondolin command shows VM status when enabled", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockPi.getFlag = vi.fn(() => true);
    await gondolinExtension(mockPi);

    const sessionStart = getEventHandler(mockPi, "session_start");
    await sessionStart({ type: "session_start", reason: "new" }, mockCtx);

    const handler = getCommandHandler(mockPi, "gondolin");
    await handler("", mockCtx);

    expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Gondolin VM:"), "info");
  });

  it("user_bash handler returns VM operations when enabled", async () => {
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockPi.getFlag = vi.fn(() => true);
    await gondolinExtension(mockPi);

    const sessionStart = getEventHandler(mockPi, "session_start");
    await sessionStart({ type: "session_start", reason: "new" }, mockCtx);

    const userBash = getEventHandler(mockPi, "user_bash");
    const result = (await userBash(
      {
        type: "user_bash",
        command: "ls",
        excludeFromContext: false,
        cwd: "/home/user/project",
      },
      mockCtx,
    )) as { operations: Record<string, unknown> };

    expect(result).toHaveProperty("operations");
    expect(result.operations).toHaveProperty("exec");
  });

  it("tool execute delegates to VM operations when enabled", async () => {
    const { createReadTool } = await import("@earendil-works/pi-coding-agent");
    const mockPi = createMockPi();
    const mockCtx = createMockCommandContext();
    mockPi.getFlag = vi.fn(() => true);
    await gondolinExtension(mockPi);

    const sessionStart = getEventHandler(mockPi, "session_start");
    await sessionStart({ type: "session_start", reason: "new" }, mockCtx);

    const readTool = getToolByName(mockPi, "read");
    expect(readTool).toBeDefined();
    await readTool.execute("tc-1", { filePath: "test.txt" }, undefined, vi.fn(), mockCtx);

    expect(createReadTool).toHaveBeenCalledWith(
      "/workspace",
      expect.objectContaining({
        operations: expect.objectContaining({
          readFile: expect.any(Function),
          access: expect.any(Function),
          detectImageMimeType: expect.any(Function),
        }),
      }),
    );
  });
});

// biome-ignore lint/suspicious/noExplicitAny: test mock
function getToolByName(mockPi: any, toolName: string): any {
  const calls = mockPi.registerTool.mock.calls;
  for (const call of calls) {
    if (call[0].name === toolName) return call[0];
  }
  return undefined;
}
