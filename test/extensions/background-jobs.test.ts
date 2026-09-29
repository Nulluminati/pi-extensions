import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "pi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import backgroundJobsExtension from "../../extensions/background-jobs/background-jobs.ts";
import {
  pruneSpoolDir,
  SPOOL_MAX_AGE_MS,
  SPOOL_MAX_FILES,
} from "../../extensions/background-jobs/src/runner.ts";
import { __resetWidgetStrip, STRIP_KEY_ABOVE } from "../../lib/widget-strip.ts";
import { createMockCommandContext } from "../mocks/context-mocks.ts";
import type { DeepMocked } from "../mocks/mock-types.ts";
import { createMockPi } from "../mocks/pi-mocks.ts";

// --- Shared mocks -----------------------------------------------------------

const spawnMock = vi.hoisted(() => vi.fn());
// Only spawn is faked; the rest of child_process (execFile for the process
// identity helpers) stays real.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

const agentDirRef = vi.hoisted(() => ({ dir: "/tmp/background-jobs-unset" }));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => agentDirRef.dir,
  CONFIG_DIR_NAME: ".pi",
}));

let spoolRoot = "/tmp/background-jobs-unset";

beforeEach(async () => {
  vi.resetAllMocks();
  spoolRoot = await mkdtemp(join(tmpdir(), "background-jobs-spool-"));
  agentDirRef.dir = spoolRoot;
});

// --- Helpers ----------------------------------------------------------------

function makeFakeChild(pid = 4242) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = pid;
  child.kill = vi.fn(() => true);
  return child;
}

function getTool(mockPi: DeepMocked<ExtensionAPI>, name: string) {
  for (const call of mockPi.registerTool.mock.calls) {
    if (call[0].name === name) return call[0];
  }
  throw new Error(`Tool ${name} not registered`);
}

function getEventHandler(mockPi: DeepMocked<ExtensionAPI>, eventType: string) {
  for (const call of mockPi.on.mock.calls) {
    if (call[0] === eventType) return call[1];
  }
  throw new Error(`Event handler for ${eventType} not found`);
}

function wakeTexts(mockPi: DeepMocked<ExtensionAPI>): string[] {
  return mockPi.sendMessage.mock.calls.map((call) => (call[0].content[0] as { text: string }).text);
}

async function startBackgroundJob(
  mockPi: DeepMocked<ExtensionAPI>,
  mockCtx: DeepMocked<ExtensionCommandContext>,
  params: Record<string, unknown>,
) {
  const tool = getTool(mockPi, "background");
  const child = makeFakeChild();
  spawnMock.mockImplementation(() => child);
  const result = await tool.execute("call-1", params, undefined, undefined, mockCtx);
  return { child, result };
}

// --- Tests ------------------------------------------------------------------

describe("background-jobs-extension", () => {
  describe("file structure", () => {
    it("keeps one discoverable entrypoint and implementation modules under src", async () => {
      const extensionDir = resolve(import.meta.dirname, "../../extensions/background-jobs");
      const rootEntries = await readdir(extensionDir, { withFileTypes: true });
      const rootTypeScriptFiles = rootEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => entry.name);
      expect(rootTypeScriptFiles).toEqual(["background-jobs.ts"]);

      const sourceFiles = await readdir(join(extensionDir, "src"));
      expect(sourceFiles.filter((file) => file.endsWith(".ts")).sort()).toEqual([
        "format.ts",
        "jobs.ts",
        "monitor.ts",
        "registry.ts",
        "runner.ts",
        "schemas.ts",
        "types.ts",
        "widget.ts",
      ]);
    });
  });

  describe("registration", () => {
    it("registers the three tools with metadata", async () => {
      const mockPi = createMockPi();
      await backgroundJobsExtension(mockPi);

      expect(mockPi.registerTool).toHaveBeenCalledTimes(3);
      for (const name of ["background", "monitor", "jobs"]) {
        expect(getTool(mockPi, name)).toEqual(
          expect.objectContaining({
            name,
            description: expect.any(String),
            parameters: expect.any(Object),
          }),
        );
      }
      expect(getTool(mockPi, "background").promptGuidelines).toEqual(
        expect.arrayContaining([expect.stringContaining("background")]),
      );
    });

    it("registers lifecycle handlers", async () => {
      const mockPi = createMockPi();
      await backgroundJobsExtension(mockPi);
      expect(mockPi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
      expect(mockPi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
    });
  });

  describe("background tool", () => {
    it("errors when command is missing", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const tool = getTool(mockPi, "background");

      const result = await tool.execute("call-1", {}, undefined, undefined, mockCtx);
      expect(result.terminate).toBe(true);
      expect(result.content[0].text).toContain("command is required");
    });

    it("errors on an invalid wake_on_pattern regexp", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const tool = getTool(mockPi, "background");

      const result = await tool.execute(
        "call-1",
        { command: "npm test", wake_on_pattern: "([bad" },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.terminate).toBe(true);
      expect(result.content[0].text).toContain("Invalid wake_on_pattern");
    });

    it("spawns detached under /bin/sh and returns a job id", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const { child, result } = await startBackgroundJob(mockPi, mockCtx, {
        command: "npm test",
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Started background job #1");
      expect(result.content[0].text).toContain("jobs");
      expect(result.details).toMatchObject({ jobId: 1, status: "running", pid: child.pid });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const spawnArgs = spawnMock.mock.calls[0];
      expect(spawnArgs[0]).toBe("npm test");
      expect(spawnArgs[1]).toMatchObject({ shell: "/bin/sh", detached: true });
    });

    it("shows the running job in a todos-style framed widget", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });

      const call = mockCtx.ui.setWidget.mock.calls.find((c) => c[0] === STRIP_KEY_ABOVE);
      expect(call).toBeDefined();
      expect(typeof call?.[1]).toBe("function");

      const factory = call?.[1] as (
        tui: unknown,
        theme: unknown,
      ) => { render: (width: number) => string[] };
      const theme = { fg: (_color: string, text: string) => text };
      const component = factory({ requestRender: vi.fn() }, theme);
      const text = component.render(80).join("\n");

      expect(text).toContain("Jobs");
      expect(text).toContain("#1");
      // The default label is the slugified command ("npm test" → "npm").
      expect(text).toContain("npm");
    });

    it("shows at most three jobs in the widget with a more indicator", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      for (const label of ["one", "two", "three", "four"]) {
        await startBackgroundJob(mockPi, mockCtx, { command: `cmd ${label}`, label });
      }

      const calls = mockCtx.ui.setWidget.mock.calls.filter(
        (call: unknown[]) => call[0] === STRIP_KEY_ABOVE,
      );
      const call = calls[calls.length - 1];
      const factory = call?.[1] as (
        tui: unknown,
        theme: unknown,
      ) => { render: (width: number) => string[] };
      const theme = { fg: (_color: string, text: string) => text };
      const component = factory({ requestRender: vi.fn() }, theme);
      const text = component.render(80).join("\n");

      expect(text).toContain("one");
      expect(text).toContain("three");
      expect(text).not.toContain("four");
      expect(text).toContain("↓ 1 more");
      expect(text).toContain("4 running");
    });

    it("captures output, wakes the agent on exit without leaking output, and clears the status", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const { child } = await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });

      child.stdout.emit("data", Buffer.from("BUILD OUTPUT LINE\n"));
      child.emit("exit", 0);

      const wakes = wakeTexts(mockPi);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toContain("#1");
      expect(wakes[0]).toContain("exit 0");
      expect(wakes[0]).not.toContain("BUILD OUTPUT LINE");
      expect(mockPi.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ customType: "background-jobs:wake" }),
        { triggerTurn: true, deliverAs: "steer" },
      );
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("exit 0"), "info");
      expect(mockCtx.ui.setWidget).toHaveBeenLastCalledWith(STRIP_KEY_ABOVE, undefined);
    });

    it("reports failure on non-zero exit", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const { child } = await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });

      child.emit("exit", 1);

      expect(wakeTexts(mockPi)[0]).toContain("exit 1");
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("exit 1"), "error");
    });

    it("reports spawn errors", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const { child } = await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });

      child.emit("error", new Error("ENOENT"));

      expect(wakeTexts(mockPi)[0]).toContain("failed to spawn");
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("ENOENT"), "error");
    });

    it("wakes once on the first wake_on_pattern match and does not repeat", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const { child } = await startBackgroundJob(mockPi, mockCtx, {
        command: "vite dev",
        wake_on_pattern: "ready in",
      });

      child.stdout.emit("data", Buffer.from("ready in 300ms\n"));
      child.stdout.emit("data", Buffer.from("ready in 400ms\n"));

      const wakes = wakeTexts(mockPi);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toContain("matched its wake_on_pattern");
      expect(wakes[0]).toContain("still running");
    });

    it("spools output to disk and records the path in the session snapshot", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const { child } = await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });

      child.stdout.emit("data", Buffer.from("spooled line\n"));
      child.emit("exit", 0);

      await vi.waitFor(async () => {
        const files = await readdir(join(spoolRoot, "background-jobs"));
        expect(files).toContain(`job-1-p${process.pid}-npm.log`);
        const text = await readFile(
          join(spoolRoot, "background-jobs", `job-1-p${process.pid}-npm.log`),
          "utf8",
        );
        expect(text).toContain("spooled line");
      });

      const snapshotCalls = mockPi.appendEntry.mock.calls.filter(
        (call) => call[0] === "background-jobs",
      );
      expect(snapshotCalls.length).toBeGreaterThanOrEqual(2);
      const lastSnapshot = snapshotCalls[snapshotCalls.length - 1][1];
      expect(lastSnapshot.jobs[0]).toMatchObject({
        id: 1,
        kind: "background",
        status: "completed",
        spoolPath: expect.stringContaining(`job-1-p${process.pid}-npm.log`),
      });
    });

    it("tolerates a stale pi handle when persisting after session end", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      mockPi.appendEntry.mockImplementation(() => {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      });
      const { child } = await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });

      expect(() => child.emit("exit", 0)).not.toThrow();
      expect(wakeTexts(mockPi)[0]).toContain("exit 0");
    });

    it("increments job ids across jobs", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const first = await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });
      const second = await startBackgroundJob(mockPi, mockCtx, { command: "vite build" });

      expect(first.result.details.jobId).toBe(1);
      expect(second.result.details.jobId).toBe(2);
    });
  });

  describe("monitor tool", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function startMonitor(
      mockPi: DeepMocked<ExtensionAPI>,
      mockCtx: DeepMocked<ExtensionCommandContext>,
      params: Record<string, unknown>,
    ) {
      const tool = getTool(mockPi, "monitor");
      return tool.execute("call-1", params, undefined, undefined, mockCtx);
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("errors when command is missing", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);

      const result = await startMonitor(mockPi, mockCtx, { satisfy_on: "exit_zero" });
      expect(result.terminate).toBe(true);
      expect(result.content[0].text).toContain("command is required");
    });

    it("errors when stdout_matches has no pattern", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);

      const result = await startMonitor(mockPi, mockCtx, {
        command: "git status",
        satisfy_on: "stdout_matches",
      });
      expect(result.terminate).toBe(true);
      expect(result.content[0].text).toContain("pattern");
    });

    it("errors on an invalid pattern regexp", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);

      const result = await startMonitor(mockPi, mockCtx, {
        command: "git status",
        satisfy_on: "stdout_matches",
        pattern: "([bad",
      });
      expect(result.terminate).toBe(true);
      expect(result.content[0].text).toContain("Invalid pattern");
    });

    it("polls via /bin/sh and wakes when satisfied", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      mockPi.exec.mockResolvedValue({ stdout: "", stderr: "", code: 0 });

      const result = await startMonitor(mockPi, mockCtx, {
        command: "git merge --no-edit",
        satisfy_on: "exit_zero",
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(result.content[0].text).toContain("Started monitor #1");
      expect(mockPi.exec).toHaveBeenCalledWith(
        "/bin/sh",
        ["-c", "git merge --no-edit"],
        expect.objectContaining({}),
      );

      const wakes = wakeTexts(mockPi);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toContain("#1");
      expect(wakes[0]).toContain("satisfied");
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("satisfied"), "info");
    });

    it("keeps polling until stdout_matches the pattern", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      mockPi.exec
        .mockResolvedValueOnce({ stdout: "pending\n", stderr: "", code: 1 })
        .mockResolvedValueOnce({ stdout: "DONE\n", stderr: "", code: 0 });

      await startMonitor(mockPi, mockCtx, {
        command: "check",
        satisfy_on: "stdout_matches",
        pattern: "DONE",
        interval_seconds: 10,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(mockPi.sendMessage).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10_000);
      const wakes = wakeTexts(mockPi);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toContain("satisfied");
      expect(mockPi.exec).toHaveBeenCalledTimes(2);
    });

    it("wakes with a timeout when the deadline passes unsatisfied", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      mockPi.exec.mockResolvedValue({ stdout: "pending", stderr: "", code: 1 });

      await startMonitor(mockPi, mockCtx, {
        command: "check",
        satisfy_on: "exit_zero",
        interval_seconds: 10,
        timeout_seconds: 25,
      });
      await vi.advanceTimersByTimeAsync(30_000);

      const wakes = wakeTexts(mockPi);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toContain("timed out");
      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("timed out"),
        "warning",
      );
    });

    it("aborts early after consecutive broken polls", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      mockPi.exec.mockResolvedValue({
        stdout: "",
        stderr: "check: command not found",
        code: 127,
      });

      await startMonitor(mockPi, mockCtx, {
        command: "check",
        satisfy_on: "exit_zero",
        interval_seconds: 1,
        timeout_seconds: 600,
      });
      await vi.advanceTimersByTimeAsync(5_000);

      const wakes = wakeTexts(mockPi);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toContain("command not found");
    });
  });

  describe("jobs tool", () => {
    it("lists an empty registry", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const tool = getTool(mockPi, "jobs");

      const result = await tool.execute(
        "call-1",
        { action: "list" },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0].text).toContain("No background jobs");
    });

    it("errors on an unknown action", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const tool = getTool(mockPi, "jobs");

      const result = await tool.execute(
        "call-1",
        { action: "nope" },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.terminate).toBe(true);
      expect(result.content[0].text).toContain("Unknown action");
    });

    it("lists jobs with status markers", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const { child } = await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });
      child.emit("exit", 0);

      const tool = getTool(mockPi, "jobs");
      const result = await tool.execute(
        "call-1",
        { action: "list" },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0].text).toContain("#1");
      expect(result.content[0].text).toContain("completed");
    });

    it("errors on status for an unknown job id", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const tool = getTool(mockPi, "jobs");

      const result = await tool.execute(
        "call-1",
        { action: "status", jobId: 99 },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.terminate).toBe(true);
      expect(result.content[0].text).toContain("No job #99");
    });

    it("tails captured output for a job", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const { child } = await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });
      child.stdout.emit("data", Buffer.from("line one\nline two\n"));
      child.emit("exit", 0);

      const tool = getTool(mockPi, "jobs");
      const result = await tool.execute(
        "call-1",
        { action: "tail", jobId: 1 },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0].text).toContain("line one");
      expect(result.content[0].text).toContain("line two");
    });

    it("says no output was captured when the buffer is empty", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      await startBackgroundJob(mockPi, mockCtx, { command: "sleep 60" });

      const tool = getTool(mockPi, "jobs");
      const result = await tool.execute(
        "call-1",
        { action: "tail", jobId: 1 },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("No output captured");
    });

    it("caps tail output at a hard character limit", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const { child } = await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });
      child.stdout.emit("data", Buffer.from(`${"x".repeat(8_000)}TAILMARKER\n`));
      child.emit("exit", 0);

      const tool = getTool(mockPi, "jobs");
      const result = await tool.execute(
        "call-1",
        { action: "tail", jobId: 1 },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0].text.length).toBeLessThan(7_000);
      expect(result.content[0].text).toContain("TAILMARKER");
    });

    it("reports cancelling a terminal job as a no-op message", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const { child } = await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });
      child.emit("exit", 0);

      const tool = getTool(mockPi, "jobs");
      const result = await tool.execute(
        "call-1",
        { action: "cancel", jobId: 1 },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("already completed");
    });

    it("does not offer a view action — the panel is user-only", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const tool = getTool(mockPi, "jobs");

      const result = await tool.execute(
        "call-1",
        { action: "view" },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.terminate).toBe(true);
      expect(result.content[0].text).toContain("Unknown action");
      expect(mockCtx.ui.custom).not.toHaveBeenCalled();
    });
  });

  describe("/jobs command", () => {
    async function openPanel(
      mockPi: DeepMocked<ExtensionAPI>,
      mockCtx: DeepMocked<ExtensionCommandContext>,
    ) {
      const call = mockPi.registerCommand.mock.calls.find((c) => c[0] === "jobs");
      const handler = call?.[1].handler as (args: string, ctx: unknown) => Promise<void>;
      await handler("", mockCtx);
      expect(mockCtx.ui.custom).toHaveBeenCalledTimes(1);
      return mockCtx.ui.custom.mock.calls[0][0] as (
        tui: unknown,
        theme: unknown,
        keybindings: unknown,
        done: (result?: unknown) => void,
      ) => { render(width: number): string[]; handleInput(data: string): void; focused: boolean };
    }

    it("registers /jobs with a description", async () => {
      const mockPi = createMockPi();
      await backgroundJobsExtension(mockPi);
      expect(mockPi.registerCommand).toHaveBeenCalledWith(
        "jobs",
        expect.objectContaining({
          description: expect.stringContaining("panel"),
          handler: expect.any(Function),
        }),
      );
    });

    it("does nothing without UI", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      mockCtx.hasUI = false;
      await backgroundJobsExtension(mockPi);
      const call = mockPi.registerCommand.mock.calls.find((c) => c[0] === "jobs");
      await call?.[1].handler("", mockCtx);
      expect(mockCtx.ui.custom).not.toHaveBeenCalled();
    });

    it("opens a panel listing jobs that closes on q", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const { child } = await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });
      child.emit("exit", 0);

      const factory = await openPanel(mockPi, mockCtx);
      const done = vi.fn();
      const component = factory(null, mockCtx.ui.theme, null, done);
      const lines = component.render(80);
      expect(lines.join("\n")).toContain("#1");
      expect(lines.join("\n")).toContain("completed");
      component.handleInput("q");
      expect(done).toHaveBeenCalled();
    });

    it("shows a key-hints bar like other modals", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });

      const factory = await openPanel(mockPi, mockCtx);
      const component = factory(null, mockCtx.ui.theme, null, vi.fn());
      const text = component.render(100).join("\n");
      expect(text).toContain("navigate");
      expect(text).toContain("page");
      expect(text).toContain("close");
    });

    it("closes the panel on protocol-encoded escape via the keybinding manager", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const { child } = await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });
      child.emit("exit", 0);

      const factory = await openPanel(mockPi, mockCtx);
      const done = vi.fn();
      // Mimic pi's KeybindingsManager as a real class-method object: `matches`
      // reads internal state through `this`, so an unbound extraction throws
      // (as does the real manager — reading its keysById map). Esc resolves in
      // every byte variant, including kitty-protocol CSI sequences.
      const keybindings = {
        bindings: {
          "\u001b": ["tui.select.cancel"],
          "\u001b[27u": ["tui.select.cancel"],
        } as Record<string, string[]>,
        matches(data: string, keybinding: string) {
          return (this.bindings[data] ?? []).includes(keybinding);
        },
      };
      const component = factory(null, mockCtx.ui.theme, keybindings, done);

      component.handleInput("\u001b[27u");

      expect(done).toHaveBeenCalled();
    });

    it("limits the paged output body to the overlay height budget on short terminals", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const { child } = await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });
      child.stdout.emit(
        "data",
        Buffer.from(Array.from({ length: 100 }, (_, i) => `line ${i}\n`).join("")),
      );
      child.emit("exit", 0);

      const factory = await openPanel(mockPi, mockCtx);
      // 20-row terminal -> overlay maxHeight is 80% -> 16 rows total, so the
      // frame body budget is 12 (after top/bottom border and padding rows).
      const component = factory(
        { requestRender: vi.fn(), terminal: { rows: 20 } },
        mockCtx.ui.theme,
        null,
        vi.fn(),
      );
      component.handleInput("\r"); // page into the output view

      const lines = component.render(80);
      expect(lines.length).toBeLessThanOrEqual(16);
      expect(lines[0]).toContain("\u256d"); // top border
      expect(lines[lines.length - 1]).toContain("\u2570"); // bottom border never clipped
      const text = lines.join("\n");
      // Only the tail of the 100-line buffer is shown; the rest collapses to
      // an indicator ("↑ N more lines") above it.
      expect(text).toContain("line 99");
      expect(text).toContain("more line");
    });

    it("fits paged output without truncation when the terminal is tall enough", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const { child } = await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });
      child.stdout.emit("data", Buffer.from("only one line of output\n"));
      child.emit("exit", 0);

      const factory = await openPanel(mockPi, mockCtx);
      const component = factory(
        { requestRender: vi.fn(), terminal: { rows: 60 } },
        mockCtx.ui.theme,
        null,
        vi.fn(),
      );
      component.handleInput("\r");

      const text = component.render(80).join("\n");
      expect(text).toContain("only one line of output");
      expect(text).not.toContain("more line");
    });

    it("truncates the job list to the height budget on very short terminals", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      for (let i = 0; i < 20; i++) {
        await startBackgroundJob(mockPi, mockCtx, { command: `job-${i}` });
      }

      const factory = await openPanel(mockPi, mockCtx);
      const component = factory(
        { requestRender: vi.fn(), terminal: { rows: 10 } },
        mockCtx.ui.theme,
        null,
        vi.fn(),
      );

      // Initially the window shows the head of the list.
      let text = component.render(80).join("\n");
      expect(text).toContain("#1");
      expect(text).not.toContain("#20");

      // Navigate all the way down; the window must scroll so #20 is visible.
      for (let i = 0; i < 25; i++) component.handleInput("j");
      text = component.render(80).join("\n");
      expect(text).toContain("#20");
      expect(text).not.toContain('"job-0"'); // #1 scrolled off the top
    });

    it("exposes a focusable contract and requests re-render after input", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const { child } = await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });
      child.emit("exit", 0);

      const factory = await openPanel(mockPi, mockCtx);
      const done = vi.fn();
      const requestRender = vi.fn();
      const tui = { requestRender };
      const component = factory(tui, mockCtx.ui.theme, null, done);

      expect("focused" in component).toBe(true);

      component.focused = true;
      component.handleInput("j");

      expect(requestRender).toHaveBeenCalled();
    });

    it("escape exits the paging view first, then closes from the list; q always closes", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const { child } = await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });
      child.emit("exit", 0);

      const factory = await openPanel(mockPi, mockCtx);
      const done = vi.fn();
      const requestRender = vi.fn();
      const component = factory({ requestRender }, mockCtx.ui.theme, null, done);

      // Enter pages into the output view.
      component.handleInput("\r");
      expect(requestRender).toHaveBeenCalled();

      // Esc from the paging view returns to the list, not out of the panel.
      done.mockClear();
      component.handleInput("\u001b");
      expect(done).not.toHaveBeenCalled();

      // Esc from the list closes the panel.
      component.handleInput("\u001b");
      expect(done).toHaveBeenCalled();

      // q closes even from the paging view.
      done.mockClear();
      component.handleInput("\r");
      component.handleInput("q");
      expect(done).toHaveBeenCalled();
    });
  });

  describe("cancellation", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("marks a job cancelled when SIGTERM reaps the child", async () => {
      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const { child } = await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });

      const tool = getTool(mockPi, "jobs");
      const pending = tool.execute(
        "call-1",
        { action: "cancel", jobId: 1 },
        undefined,
        undefined,
        mockCtx,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");

      child.emit("exit", null, "SIGTERM");
      await vi.advanceTimersByTimeAsync(100);
      const result = await pending;

      expect(result.content[0].text).toContain("cancelled");
      expect(result.details).toMatchObject({ jobId: 1, status: "cancelled" });
    });

    it("escalates to SIGKILL when SIGTERM is ignored", async () => {
      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const { child } = await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });

      const tool = getTool(mockPi, "jobs");
      const pending = tool.execute(
        "call-1",
        { action: "cancel", jobId: 1 },
        undefined,
        undefined,
        mockCtx,
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(killSpy).toHaveBeenCalledWith(-4242, "SIGKILL");

      child.emit("exit", null, "SIGKILL");
      await vi.advanceTimersByTimeAsync(100);
      const result = await pending;
      expect(result.content[0].text).toContain("cancelled");
    });

    it("records kill_failed when the group survives SIGKILL", async () => {
      vi.spyOn(process, "kill").mockReturnValue(true);
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });

      const tool = getTool(mockPi, "jobs");
      const pending = tool.execute(
        "call-1",
        { action: "cancel", jobId: 1 },
        undefined,
        undefined,
        mockCtx,
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(8_000);

      const result = await pending;
      expect(result.content[0].text).toContain("kill_failed");
      expect(result.details).toMatchObject({ status: "kill_failed" });
    });

    it("cancels a monitor immediately when it has no child", async () => {
      vi.useFakeTimers();
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      mockPi.exec.mockResolvedValue({ stdout: "pending", stderr: "", code: 1 });
      const monitorTool = getTool(mockPi, "monitor");
      await monitorTool.execute(
        "call-1",
        { command: "check", satisfy_on: "exit_zero", interval_seconds: 10 },
        undefined,
        undefined,
        mockCtx,
      );
      await vi.advanceTimersByTimeAsync(0);

      const jobsTool = getTool(mockPi, "jobs");
      const result = await jobsTool.execute(
        "call-2",
        { action: "cancel", jobId: 1 },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0].text).toContain("cancelled");
    });
  });

  describe("lifecycle", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("cancels running jobs and suppresses wakes after session_shutdown", async () => {
      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const { child } = await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });

      const shutdown = getEventHandler(mockPi, "session_shutdown");
      await shutdown({ type: "session_shutdown" }, mockCtx);
      await vi.advanceTimersByTimeAsync(0);

      expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
      child.emit("exit", null, "SIGTERM");
      await vi.advanceTimersByTimeAsync(100);

      expect(mockPi.sendMessage).not.toHaveBeenCalled();
    });

    it("resets the registry on session_start", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const { child } = await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });
      child.emit("exit", 0);

      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "new" }, mockCtx);

      const tool = getTool(mockPi, "jobs");
      const result = await tool.execute(
        "call-1",
        { action: "list" },
        undefined,
        undefined,
        mockCtx,
      );
      expect(result.content[0].text).toContain("No background jobs");
    });
  });

  describe("status-line fallback", () => {
    it("publishes the status fallback while jobs are active", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });

      expect(mockCtx.ui.setStatus).toHaveBeenCalledWith(
        "background-jobs",
        expect.stringContaining("Jobs: 1 job: #1 npm"),
      );
    });

    it("clears the status fallback when the last active job exits", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      const { child } = await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });
      mockCtx.ui.setStatus.mockClear();

      child.emit("exit", 0);

      expect(mockCtx.ui.setStatus).toHaveBeenLastCalledWith("background-jobs", undefined);
    });

    it("clears the status fallback on session_start", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      await backgroundJobsExtension(mockPi);
      await startBackgroundJob(mockPi, mockCtx, { command: "npm test" });
      mockCtx.ui.setStatus.mockClear();

      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "new" }, mockCtx);

      expect(mockCtx.ui.setStatus).toHaveBeenLastCalledWith("background-jobs", undefined);
    });

    it("does not publish the status fallback without UI", async () => {
      const mockPi = createMockPi();
      const mockCtx = createMockCommandContext();
      mockCtx.hasUI = false;
      await backgroundJobsExtension(mockPi);

      const sessionStart = getEventHandler(mockPi, "session_start");
      await sessionStart({ type: "session_start", reason: "new" }, mockCtx);

      expect(mockCtx.ui.setStatus).not.toHaveBeenCalled();
    });
  });
});

// --- Spool retention --------------------------------------------------------

describe("spool retention", () => {
  let dir: string;

  beforeEach(async () => {
    __resetWidgetStrip();
    dir = await mkdtemp(join(tmpdir(), "background-jobs-prune-"));
  });

  async function writeSpool(name: string, content: string, ageMs = 0): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, content, "utf8");
    if (ageMs > 0) {
      const when = new Date(Date.now() - ageMs);
      await utimes(path, when, when);
    }
    return path;
  }

  it("deletes logs past the age limit and keeps fresh ones", async () => {
    const old = await writeSpool("job-1-old.log", "old", SPOOL_MAX_AGE_MS + 60_000);
    const fresh = await writeSpool("job-2-fresh.log", "fresh");

    expect(await pruneSpoolDir(dir)).toBe(1);
    await expect(readFile(old, "utf8")).rejects.toThrow();
    expect(await readFile(fresh, "utf8")).toBe("fresh");
  });

  it("never deletes a live job's log", async () => {
    const live = await writeSpool("job-1-live.log", "live", SPOOL_MAX_AGE_MS + 60_000);

    expect(await pruneSpoolDir(dir, { keep: new Set([live]) })).toBe(0);
    expect(await readFile(live, "utf8")).toBe("live");
  });

  it("never deletes a pid-stamped log whose owning process is alive", async () => {
    // Another session's active job: its registry is invisible here, but the
    // pid stamp in the name proves the owner is live.
    const other = await writeSpool(
      `job-7-p${process.pid}-silent.log`,
      "other session",
      SPOOL_MAX_AGE_MS + 60_000,
    );

    expect(await pruneSpoolDir(dir)).toBe(0);
    expect(await readFile(other, "utf8")).toBe("other session");
  });

  it("deletes a pid-stamped log whose owning process is dead", async () => {
    const dead = await writeSpool("job-8-p999999999-dead.log", "dead", SPOOL_MAX_AGE_MS + 60_000);

    expect(await pruneSpoolDir(dir)).toBe(1);
    await expect(readFile(dead, "utf8")).rejects.toThrow();
  });

  it("caps the directory at maxFiles, dropping the oldest first", async () => {
    const base = Date.now() - 60_000;
    for (let i = 1; i <= 5; i += 1) {
      const path = join(dir, `job-${i}-task.log`);
      await writeFile(path, String(i), "utf8");
      const when = new Date(base + i * 1_000);
      await utimes(path, when, when);
    }

    expect(await pruneSpoolDir(dir, { maxFiles: 2 })).toBe(3);

    const remaining = (await readdir(dir)).sort();
    expect(remaining).toEqual(["job-4-task.log", "job-5-task.log"]);
  });

  it("leaves files that are not job logs alone", async () => {
    await writeSpool("notes.txt", "keep me", SPOOL_MAX_AGE_MS + 60_000);
    await writeSpool("job-1-old.log", "delete me", SPOOL_MAX_AGE_MS + 60_000);

    expect(await pruneSpoolDir(dir)).toBe(1);
    expect(await readdir(dir)).toEqual(["notes.txt"]);
  });

  it("returns zero when the spool directory does not exist yet", async () => {
    expect(await pruneSpoolDir(join(dir, "missing"))).toBe(0);
  });

  it("applies the default file cap", async () => {
    await Promise.all(
      Array.from({ length: SPOOL_MAX_FILES + 1 }, (_, i) =>
        writeFile(join(dir, `job-${i + 1}-task.log`), String(i), "utf8"),
      ),
    );

    expect(await pruneSpoolDir(dir)).toBe(1);
    expect((await readdir(dir)).length).toBe(SPOOL_MAX_FILES);
  });
});

describe("slugify", () => {
  it("lowercases the label so case variants cannot collide on folding volumes", async () => {
    const { slugify } = await import("../../extensions/background-jobs/src/format.ts");
    expect(slugify("BUILD app")).toBe("build");
    expect(slugify("Npm test")).toBe("npm");
    expect(slugify("./Tools/x")).toBe(".toolsx");
  });
});
