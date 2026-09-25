import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import gondolinExtension from "../../extensions/gondolin/gondolin.ts";
import { GUEST_WORKSPACE } from "../../extensions/gondolin/src/constants.ts";
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
  // Tagged fake providers so tests can tell the writable provider from the
  // read-only wrapper (and see which host path each was built for) without
  // loading the real native addon.
  RealFSProvider: vi.fn(function fakeRealFsProvider(
    this: Record<string, unknown>,
    mountedPath?: string,
  ) {
    this.mountedPath = mountedPath;
    this.writable = true;
  }),
  ReadonlyProvider: vi.fn(function fakeReadonlyProvider(
    this: Record<string, unknown>,
    backend?: unknown,
  ) {
    this.backend = backend;
    this.readonly = true;
  }),
  MemoryProvider: vi.fn(),
}));

// The extension reads git metadata (`.git` pointer file, `commondir`) from the
// host filesystem; keep every other fs/promises export (readdir, etc.) real.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: vi.fn(),
  stat: vi.fn(),
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

vi.mock("../../lib/guest-image.ts", () => ({
  resolveGuestImagePath: vi.fn(),
}));

import { resolveGuestImagePath } from "../../lib/guest-image.ts";

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
      expect(sourceFiles.filter((file) => file.endsWith(".ts"))).toHaveLength(7);
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

  it("closes the VM and records a startup error when the shell probe fails after create", async () => {
    const mockPi = createMockPi();
    await gondolinExtension(mockPi);
    mockPi.getFlag = vi.fn(() => true);
    const { VM } = (await import("@earendil-works/gondolin")) as unknown as {
      VM: { create: ReturnType<typeof vi.fn> };
    };
    VM.create.mockImplementation(() => Promise.resolve(mockVm));
    mockVm.exec.mockRejectedValueOnce(new Error("probe boom"));

    const ctx = createMockCommandContext();
    const sessionStart = getEventHandler(mockPi, "session_start");
    await expect(sessionStart({ type: "session_start", reason: "startup" }, ctx)).rejects.toThrow(
      /Gondolin VM failed to start/,
    );

    // Create plus probe is one initialization transaction: the created VM is
    // closed on post-create failure so a retry cannot leak it.
    expect(mockVm.close).toHaveBeenCalled();

    // The failure is recorded persistently: subsequent tool calls fail loudly
    // with the recorded error instead of leaking another VM or falling back
    // to the host filesystem.
    const tools = mockPi.registerTool.mock.calls.map((call) => call[0]);
    const readTool = tools.find((tool) => tool.name === "read");
    await expect(readTool.execute("id", { path: "x" }, undefined, undefined, ctx)).rejects.toThrow(
      /probe boom/,
    );
  });

  it("starts and stops the VM headlessly without touching a missing UI", async () => {
    const mockPi = createMockPi();
    await gondolinExtension(mockPi);
    mockPi.getFlag = vi.fn(() => true);
    const { VM } = (await import("@earendil-works/gondolin")) as unknown as {
      VM: { create: ReturnType<typeof vi.fn> };
    };
    VM.create.mockImplementation(() => Promise.resolve(mockVm));

    const ctx = createMockCommandContext();
    ctx.hasUI = false;
    (ctx as unknown as { ui: undefined }).ui = undefined;

    const sessionStart = getEventHandler(mockPi, "session_start");
    await expect(
      sessionStart({ type: "session_start", reason: "startup" }, ctx),
    ).resolves.toBeUndefined();
    expect(VM.create).toHaveBeenCalled();

    const sessionShutdown = getEventHandler(mockPi, "session_shutdown");
    await expect(
      sessionShutdown({ type: "session_shutdown", reason: "exit" }, ctx),
    ).resolves.toBeUndefined();
    expect(mockVm.close).toHaveBeenCalled();
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

  describe("sandboxed worktree git mounts", () => {
    const GITDIR_PATH = "/host/main-checkout/.git/worktrees/w-test";
    const MAIN_GIT_PATH = "/host/main-checkout/.git";

    beforeEach(() => {
      process.env.PI_WORKER = "1";
    });

    afterEach(() => {
      delete process.env.PI_WORKER;
    });

    it("worker with a .git pointer file mounts the worktree gitdir writable and the main .git read-only at their absolute host paths", async () => {
      const gondolin = await getGondolinMocks();
      const fs = await getFsMocks();
      mockWorktreeFs(fs, {
        gitdirPath: GITDIR_PATH,
        mainGitPath: MAIN_GIT_PATH,
      });

      const mockPi = createMockPi();
      mockPi.getFlag = vi.fn(() => true);
      await gondolinExtension(mockPi);
      const sessionStart = getEventHandler(mockPi, "session_start");
      await expect(
        sessionStart({ type: "session_start", reason: "startup" }, createMockCommandContext()),
      ).resolves.toBeUndefined();

      // The pointer file's gitdir target is an absolute host path, so the
      // mounts must be keyed at the same absolute paths: the guest path equals
      // the host path for git's resolution chain to work in-guest.
      const mounts = getCreatedMounts(gondolin.VM.create);
      expect(Object.keys(mounts)).toContain(GITDIR_PATH);
      expect(Object.keys(mounts)).toContain(MAIN_GIT_PATH);

      // The gitdir mount is the writable provider itself (per-worktree index
      // and logs); the main .git mount is the read-only wrapper around its own
      // writable provider.
      expect(mounts[GITDIR_PATH]).toMatchObject({ writable: true, mountedPath: GITDIR_PATH });
      expect(mounts[MAIN_GIT_PATH]).toMatchObject({ readonly: true });
      expect(mounts[MAIN_GIT_PATH]?.backend).toMatchObject({ mountedPath: MAIN_GIT_PATH });
      expect(gondolin.ReadonlyProvider).toHaveBeenCalledTimes(1);

      // Guest uid 0 vs uid-1000 mounts: git would refuse the repo as
      // "dubious" without safe.directory declarations passed as VM env.
      const env = getCreatedEnv(gondolin.VM.create);
      expect(env.GIT_CONFIG_COUNT).toBe("3");
      expect(env.GIT_CONFIG_KEY_0).toBe("safe.directory");
      expect(env.GIT_CONFIG_VALUE_0).toBe(GUEST_WORKSPACE);
      expect([env.GIT_CONFIG_VALUE_1, env.GIT_CONFIG_VALUE_2]).toContain(dirname(MAIN_GIT_PATH));
    });

    it("worker with a real .git directory (normal checkout) adds no extra mounts", async () => {
      const gondolin = await getGondolinMocks();
      const fs = await getFsMocks();
      mockWorktreeFs(fs, { gitdirPath: GITDIR_PATH, dotGit: "directory" });

      const mockPi = createMockPi();
      mockPi.getFlag = vi.fn(() => true);
      await gondolinExtension(mockPi);
      const sessionStart = getEventHandler(mockPi, "session_start");
      await expect(
        sessionStart({ type: "session_start", reason: "startup" }, createMockCommandContext()),
      ).resolves.toBeUndefined();

      expect(Object.keys(getCreatedMounts(gondolin.VM.create))).toEqual([GUEST_WORKSPACE]);
      expect(gondolin.ReadonlyProvider).not.toHaveBeenCalled();
    });

    it("worker with a missing .git adds no extra mounts", async () => {
      const gondolin = await getGondolinMocks();
      const fs = await getFsMocks();
      mockWorktreeFs(fs, { gitdirPath: GITDIR_PATH, dotGit: "absent" });

      const mockPi = createMockPi();
      mockPi.getFlag = vi.fn(() => true);
      await gondolinExtension(mockPi);
      const sessionStart = getEventHandler(mockPi, "session_start");
      await expect(
        sessionStart({ type: "session_start", reason: "startup" }, createMockCommandContext()),
      ).resolves.toBeUndefined();

      expect(Object.keys(getCreatedMounts(gondolin.VM.create))).toEqual([GUEST_WORKSPACE]);
    });

    it("non-worker does not mount git metadata even when a .git pointer file exists", async () => {
      const gondolin = await getGondolinMocks();
      const fs = await getFsMocks();
      mockWorktreeFs(fs, { gitdirPath: GITDIR_PATH, mainGitPath: MAIN_GIT_PATH });
      delete process.env.PI_WORKER;

      const mockPi = createMockPi();
      mockPi.getFlag = vi.fn(() => true);
      await gondolinExtension(mockPi);
      const sessionStart = getEventHandler(mockPi, "session_start");
      await expect(
        sessionStart({ type: "session_start", reason: "startup" }, createMockCommandContext()),
      ).resolves.toBeUndefined();

      expect(Object.keys(getCreatedMounts(gondolin.VM.create))).toEqual([GUEST_WORKSPACE]);
      expect(gondolin.ReadonlyProvider).not.toHaveBeenCalled();

      // Parent sessions still get the workspace declared safe: the uid
      // mismatch exists for every sandbox, worker or not.
      const env = getCreatedEnv(gondolin.VM.create);
      expect(env.GIT_CONFIG_COUNT).toBe("1");
      expect(env.GIT_CONFIG_KEY_0).toBe("safe.directory");
      expect(env.GIT_CONFIG_VALUE_0).toBe(GUEST_WORKSPACE);
    });

    it("worker resolves an unusual commondir relative path to the main .git", async () => {
      const gondolin = await getGondolinMocks();
      const fs = await getFsMocks();
      const gitdirPath = "/srv/git/worktrees/w-custom";
      const mainGitPath = "/srv/main/.git";
      mockWorktreeFs(fs, {
        gitdirPath,
        mainGitPath,
        pointerContent: `gitdir: ${gitdirPath}\n`,
        commondirContent: "../../../main/.git\n",
      });

      const mockPi = createMockPi();
      mockPi.getFlag = vi.fn(() => true);
      await gondolinExtension(mockPi);
      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "startup" }, createMockCommandContext());

      const mounts = getCreatedMounts(gondolin.VM.create);
      expect(mounts[gitdirPath]).toMatchObject({ writable: true, mountedPath: gitdirPath });
      expect(mounts[mainGitPath]).toMatchObject({ readonly: true });
      expect(mounts[mainGitPath]?.backend).toMatchObject({ mountedPath: mainGitPath });
    });

    it("worker skips the git mounts silently when the pointer file has no gitdir: line", async () => {
      const gondolin = await getGondolinMocks();
      const fs = await getFsMocks();
      mockWorktreeFs(fs, {
        gitdirPath: GITDIR_PATH,
        mainGitPath: MAIN_GIT_PATH,
        pointerContent: "ref: refs/heads/main\n",
      });

      const mockPi = createMockPi();
      mockPi.getFlag = vi.fn(() => true);
      await gondolinExtension(mockPi);
      const sessionStart = getEventHandler(mockPi, "session_start");
      await expect(
        sessionStart({ type: "session_start", reason: "startup" }, createMockCommandContext()),
      ).resolves.toBeUndefined();

      expect(Object.keys(getCreatedMounts(gondolin.VM.create))).toEqual([GUEST_WORKSPACE]);
    });

    it("worker skips the git mounts when the resolved main .git directory does not exist", async () => {
      const gondolin = await getGondolinMocks();
      const fs = await getFsMocks();
      mockWorktreeFs(fs, {
        gitdirPath: GITDIR_PATH,
        mainGitPath: MAIN_GIT_PATH,
        mainGitDirExists: false,
      });

      const mockPi = createMockPi();
      mockPi.getFlag = vi.fn(() => true);
      await gondolinExtension(mockPi);
      const sessionStart = getEventHandler(mockPi, "session_start");
      await expect(
        sessionStart({ type: "session_start", reason: "startup" }, createMockCommandContext()),
      ).resolves.toBeUndefined();

      expect(Object.keys(getCreatedMounts(gondolin.VM.create))).toEqual([GUEST_WORKSPACE]);
    });
  });

  describe("custom guest image", () => {
    it("passes the built custom image as sandbox.imagePath into VM.create", async () => {
      vi.mocked(resolveGuestImagePath).mockReturnValue("/cache/pi-gondolin/guest");
      const mockPi = createMockPi();
      await gondolinExtension(mockPi);
      mockPi.getFlag = vi.fn(() => true);
      const { VM } = (await import("@earendil-works/gondolin")) as unknown as {
        VM: { create: ReturnType<typeof vi.fn> };
      };

      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "startup" }, createMockCommandContext());

      expect(VM.create).toHaveBeenCalledWith(
        expect.objectContaining({ sandbox: { imagePath: "/cache/pi-gondolin/guest" } }),
      );
    });

    it("omits the sandbox key when no custom image is built (SDK default registry image)", async () => {
      const mockPi = createMockPi();
      await gondolinExtension(mockPi);
      mockPi.getFlag = vi.fn(() => true);
      const { VM } = (await import("@earendil-works/gondolin")) as unknown as {
        VM: { create: ReturnType<typeof vi.fn> };
      };

      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "startup" }, createMockCommandContext());

      const createCall = VM.create.mock.calls[0]?.[0];
      expect(createCall).toBeDefined();
      expect(createCall).not.toHaveProperty("sandbox");
    });
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

// biome-ignore lint/suspicious/noExplicitAny: untyped mock handle, see comment
type UntypedMock = any;

async function getGondolinMocks(): Promise<{
  VM: { create: UntypedMock };
  RealFSProvider: UntypedMock;
  ReadonlyProvider: UntypedMock;
}> {
  return (await import("@earendil-works/gondolin")) as unknown as {
    VM: { create: UntypedMock };
    RealFSProvider: UntypedMock;
    ReadonlyProvider: UntypedMock;
  };
}

async function getFsMocks(): Promise<{ readFile: UntypedMock; stat: UntypedMock }> {
  return (await import("node:fs/promises")) as unknown as {
    readFile: UntypedMock;
    stat: UntypedMock;
  };
}

interface WorktreeFsOptions {
  gitdirPath: string;
  /** Absolute path of the resolved main .git; stat succeeds for it when mainGitDirExists. */
  mainGitPath?: string | undefined;
  /** Shape of the worktree's .git entry. Default "pointer". */
  dotGit?: "pointer" | "directory" | "absent" | undefined;
  /** Content of the .git pointer file. Default `gitdir: <gitdirPath>`. */
  pointerContent?: string | undefined;
  /** Content of the gitdir's commondir file. Default "../..". */
  commondirContent?: string | undefined;
  /** Whether the resolved main .git directory exists. Default true. */
  mainGitDirExists?: boolean | undefined;
}

/** Simulates the host-side git metadata a linked worktree worker would read. */
function mockWorktreeFs(
  fs: { readFile: UntypedMock; stat: UntypedMock },
  options: WorktreeFsOptions,
): void {
  const dotGitPath = resolve(process.cwd(), ".git");
  const dotGit = options.dotGit ?? "pointer";
  const enoent = (target: unknown) =>
    Object.assign(new Error(`ENOENT: no such file or directory, ${String(target)}`), {
      code: "ENOENT",
    });

  fs.readFile.mockImplementation(async (target: unknown) => {
    if (target === dotGitPath) {
      if (dotGit === "pointer") return options.pointerContent ?? `gitdir: ${options.gitdirPath}\n`;
      if (dotGit === "directory") {
        throw Object.assign(new Error("EISDIR: illegal operation on a directory, read"), {
          code: "EISDIR",
        });
      }
      throw enoent(target);
    }
    if (target === `${options.gitdirPath}/commondir`) {
      return options.commondirContent ?? "../..\n";
    }
    throw enoent(target);
  });

  fs.stat.mockImplementation(async (target: unknown) => {
    if (target === options.mainGitPath && options.mainGitDirExists !== false) {
      return { isFile: () => false, isDirectory: () => true };
    }
    throw enoent(target);
  });
}

function getCreatedMounts(vmCreate: UntypedMock): Record<string, Record<string, unknown>> {
  const createArg = vmCreate.mock.calls[0]?.[0] as
    | { vfs?: { mounts?: Record<string, Record<string, unknown>> } }
    | undefined;
  return createArg?.vfs?.mounts ?? {};
}

function getCreatedEnv(vmCreate: UntypedMock): Record<string, string> {
  const createArg = vmCreate.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined;
  return createArg?.env ?? {};
}
